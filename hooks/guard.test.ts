// Drives the real hooks: the test's own tool.call hook stands for the command running.

import { expect, test } from 'claude-code/testing'

const GH = `  ✓ Logged in to github.com account MohamedHamed001 (keyring)
  - Active account: true
  ✓ Logged in to github.com account MohamedHamedSeiTech (keyring)
  - Active account: false
`

/**
 * A machine with two gh accounts (the personal one active) and a repository whose git name
 * is `gitName`. `answer` is what the person picks in the dialog; null closes it.
 * Returns the list of commands that actually ran.
 */
function fakeMachine(on: any, gitName: string, answer: string | null) {
  const ran: string[] = []
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const text = e.argv[0] === 'gh' ? GH : e.argv.at(-1) === 'user.name' ? gitName : ''

    return { value: { exitCode: 0, stdout: text, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  // The dialog is the engine's AskUserQuestion tool; every other tool call is "the command".
  on('tool.call', (_: unknown, e: { tool: string; command: string; questions: Array<{ question: string }> }) => {
    if (e.tool === 'AskUserQuestion') {
      if (answer === null) throw new Error('dismissed')

      return { result: { questions: e.questions, answers: { [e.questions[0].question]: answer } } } as never
    }
    ran.push(e.command)

    return { result: { stdout: 'ok' } } as never
  })

  return ran
}

const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', command } as never)

test('a push with the wrong active account is refused and names the switch command', async ($, on) => {
  const ran = fakeMachine(on, 'MohamedHamedSeiTech', 'Run it')
  const answer = await bash($, 'git push origin main')
  expect(ran).toEqual([])
  expect(JSON.stringify(answer)).toContain('gh auth switch --hostname github.com --user MohamedHamedSeiTech')
})

test('a push with the right account runs', async ($, on) => {
  const ran = fakeMachine(on, 'MohamedHamed001', 'Run it')
  await bash($, 'git push origin main')
  expect(ran).toEqual(['git push origin main'])
})

test('a push from a repository that names no account runs', async ($, on) => {
  const ran = fakeMachine(on, 'Someone Unrelated', 'Run it')
  await bash($, 'git push origin main')
  expect(ran).toEqual(['git push origin main'])
})

test('a git command that fails is "no evidence", never an account name', async ($, on) => {
  const ran: string[] = []
  const failed = { exitCode: 128, stdout: '', stderr: 'fatal: cannot change to x', isStdoutTruncated: false, isStderrTruncated: false }
  const worked = { exitCode: 0, stdout: GH, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  on('process.run', (_: unknown, e: { argv: string[] }) => ({ value: e.argv[0] === 'gh' ? worked : failed }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_: unknown, e: { command: string }) => {
    ran.push(e.command)

    return { result: { stdout: 'ok' } } as never
  })
  await bash($, 'cd /d/Projects/x && git push')
  expect(ran).toEqual(['cd /d/Projects/x && git push'])
})

test('a destructive command runs only after Run it', async ($, on) => {
  const ran = fakeMachine(on, '', 'Run it')
  await bash($, 'rm -rf build')
  expect(ran).toEqual(['rm -rf build'])
})

test('Cancel, or closing the dialog, refuses the command', async ($, on) => {
  const ran = fakeMachine(on, '', null)
  const answer = await bash($, 'git reset --hard')
  expect(ran).toEqual([])
  expect(JSON.stringify(answer)).toContain('cancelled')
})

test('ordinary commands are not asked about', async ($, on) => {
  const ran = fakeMachine(on, '', null)
  await bash($, 'git status')
  expect(ran).toEqual(['git status'])
})
