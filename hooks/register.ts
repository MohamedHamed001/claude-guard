// Guard: two checks on every shell command Claude runs, before it runs.
//
//   1. Wrong GitHub account. A `git push` or `gh pr create` is refused when the active gh
//      account is not the one this repository is pushed with.
//   2. Destructive commands. A recursive delete, a DROP DATABASE, a hard reset, a force push
//      and the like open a dialog that says what would be removed: Run it / Cancel.
//
// How a check stops a command: a `tool.call` hook sees the command first. Calling `next(e)`
// lets it run; returning `{ deny: text }` refuses it, and Claude receives the text as the
// reason. The rules themselves (what counts as dangerous, which account is expected) are in
// logic.ts.

import type { EngineInterface, Register } from 'claude-code'

import {
  danger,
  dangerQuestion,
  expectedAccount,
  folderOf,
  isPublish,
  nativePath,
  parseGhAccounts,
  runPart,
  wrongAccountText,
} from './logic'

const RUN = 'Run it'
const CANCEL = 'Cancel'

// The folder the session runs in: where a command works unless it names another.
let sessionFolder = '.'

/**
 * Run a program and return what it printed, or '' if it failed or could not run.
 * Error text is never returned: a failed `git config` must read as "no value", not as a
 * value that happens to be an error message.
 */
async function output($: EngineInterface, argv: string[]): Promise<string> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: 10_000 })
    if (ran.exitCode !== 0) {
      return ''
    }

    // Older gh versions print `auth status` on stderr.
    return argv[0] === 'gh' ? `${ran.stdout}\n${ran.stderr}` : ran.stdout
  } catch {
    return ''
  }
}

/** The folder a command works in, in the form programs outside the shell understand. */
function workFolder(command: string): string {
  return nativePath(folderOf(command) ?? sessionFolder, sessionFolder)
}

/** The refusal text if this push would go out under the wrong account, else null. */
async function wrongAccount($: EngineInterface, command: string): Promise<string | null> {
  const folder = workFolder(command)
  const accounts = parseGhAccounts(await output($, ['gh', 'auth', 'status']))
  if (accounts.all.length < 2) {
    return null // one account, or no gh: nothing to mix up
  }
  const git = (key: string) => output($, ['git', '-C', folder, 'config', key])
  const expected = expectedAccount(
    await git('guard.account'),
    `${await git('user.name')} ${await git('user.email')}`,
    accounts.all,
  )

  return expected !== null && expected !== accounts.active ? wrongAccountText(accounts.active, expected) : null
}

/** "12 items at the top level" for each delete target that is an existing folder. */
async function folderSizes($: EngineInterface, command: string, targets: string[]): Promise<Record<string, string>> {
  const base = workFolder(command)
  const sizes: Record<string, string> = {}
  for (const target of targets.slice(0, 5)) {
    const isAbsolute = /^([A-Za-z]:|[\\/~$])/.test(target)
    try {
      const entries = await $.fs.list(isAbsolute ? nativePath(target, sessionFolder) : `${base}/${target}`)
      sizes[target] = `${entries.length} item${entries.length === 1 ? '' : 's'} at the top level`
    } catch {
      // Not a folder we can read (a file, a pattern, a variable): show the name alone.
    }
  }

  return sizes
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    sessionFolder = e.cwd

    return next(e)
  })

  for (const shell of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool: shell }, async ($, e, next) => {
      // A fault in the guard must never stop ordinary work: on any error, the command runs.
      let refusal: string | null = null
      try {
        // Text being written to a file is not a command: see runPart.
        const command = runPart(e.command)
        if (isPublish(command)) {
          refusal = await wrongAccount($, command)
          if (refusal) {
            $.ui.toast('Push stopped: the wrong GitHub account is active')
          }
        }

        const found = refusal ? null : danger(command)
        if (found) {
          const sizes = found.isDelete ? await folderSizes($, command, found.targets) : {}
          let answer = CANCEL
          try {
            answer = await $.ui.ask(dangerQuestion(command, found, sizes), { header: 'Guard', options: [RUN, CANCEL] })
          } catch {
            // Dismissed: treat it as Cancel, so nothing is destroyed by accident.
          }
          if (answer !== RUN) {
            refusal =
              'The user cancelled this command in the guard dialog' +
              (answer !== CANCEL ? ` and wrote: "${answer}"` : '') +
              '. Do not retry it or work around it; ask what they want instead.'
          }
        }
      } catch {
        refusal = null
      }

      return refusal ? { deny: refusal } : next(e)
    })
  }
}
