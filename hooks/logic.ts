// The rules of the guard, as plain functions with no access to the machine, so they can be
// tested by themselves. register.ts runs the commands and shows the dialogs.

/**
 * The part of a shell command that is actually run. A heredoc (`cat > file <<'EOF' ...`)
 * carries a file's text inside the command; that text can mention `git push` or `rm -rf`
 * without running them, so everything from the first heredoc marker on is left out.
 */
export function runPart(command: string): string {
  return command.split(/<<-?\s*['"]?\w+/)[0]
}

// ---- Wrong GitHub account ------------------------------------------------------------

/** Does this shell command send something to GitHub under the signed-in account? */
export function isPublish(command: string): boolean {
  return (
    /\bgit\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?push\b/.test(command) ||
    /\bgh\s+(?:pr\s+(?:create|merge)|repo\s+create|release\s+create)\b/.test(command)
  )
}

/**
 * The folder a command works in when it says so itself: `git -C <folder> ...` or a leading
 * `cd <folder> && ...`. Null means "the session's own folder".
 */
export function folderOf(command: string): string | null {
  const match =
    command.match(/\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/) ??
    command.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)/)

  return match ? (match[1] ?? match[2] ?? match[3]) : null
}

/**
 * Git Bash writes drive paths as "/d/Projects/x"; programs started outside it (git, here)
 * need "d:/Projects/x". Only converted when the session itself runs on a Windows path, so a
 * real "/d/..." folder on Linux or macOS is left alone.
 */
export function nativePath(path: string, sessionFolder: string): string {
  const isWindows = /^[A-Za-z]:[\\/]/.test(sessionFolder)

  return isWindows ? path.replace(/^\/([A-Za-z])\//, '$1:/') : path
}

/** The accounts `gh auth status` lists, and which one is active. */
export type GhAccounts = { active: string | null; all: string[] }

export function parseGhAccounts(output: string): GhAccounts {
  const accounts: GhAccounts = { active: null, all: [] }
  let last: string | null = null
  for (const line of output.split('\n')) {
    const login = line.match(/Logged in to \S+ account (\S+)/)
    if (login) {
      last = login[1]
      accounts.all.push(last)
    } else if (/Active account:\s*true/.test(line) && last) {
      accounts.active = last
    }
  }

  return accounts
}

/**
 * The account this repository should be pushed with, or null when we cannot tell.
 *
 * First choice: the repository says so itself (`git config guard.account <login>`).
 * Otherwise: a signed-in account whose login appears in the repository's git name or
 * email, e.g. email "74424205+MohamedHamed001@users.noreply.github.com" -> MohamedHamed001.
 * No evidence means null, and a null never blocks a push.
 */
export function expectedAccount(configured: string, gitIdentity: string, signedIn: readonly string[]): string | null {
  if (configured.trim()) {
    return configured.trim()
  }
  const identity = gitIdentity.toLowerCase()

  return signedIn.find(login => identity.includes(login.toLowerCase())) ?? null
}

/** The text Claude receives when a push is refused. */
export function wrongAccountText(active: string | null, expected: string): string {
  return (
    `Blocked by the guard plugin: this repository is pushed as "${expected}", but the active gh account is ` +
    `"${active ?? 'none'}". Nothing was sent. Tell the user, and ask before running: ` +
    `gh auth switch --hostname github.com --user ${expected}`
  )
}

// ---- Commands that destroy things -----------------------------------------------------

/** What a destructive command would do, and the things it names. */
export type Danger = { what: string; targets: string[]; isDelete: boolean }

/** The plain arguments of a command: no flags, quotes removed, up to the next ; | or &. */
function plainArgs(rest: string): string[] {
  const untilNext = rest.split(/[;|&\n]/)[0]

  return [...untilNext.matchAll(/"([^"]+)"|'([^']+)'|(\S+)/g)]
    .map(match => match[1] ?? match[2] ?? match[3])
    .filter(arg => !arg.startsWith('-'))
}

/** A place where deleting is routine: temp folders and scratchpads. */
const THROWAWAY = /(^|[\\/])(te?mp|scratchpad)([\\/]|$)|^\$\{?(TE?MP|TMPDIR)\b/i

/** A recursive delete of `targets`, or null when they are all throwaway places. */
function deleteOf(targets: string[]): Danger | null {
  if (targets.length > 0 && targets.every(target => THROWAWAY.test(target))) {
    return null
  }

  return { what: 'deletes folders and everything inside them', targets, isDelete: true }
}

/**
 * Recognise a command that cannot be undone. Returns null for everything else, and for
 * deletes that only touch temp or scratchpad folders.
 */
export function danger(command: string): Danger | null {
  // rm -r / rm -rf / rm --recursive
  const rm = command.match(/\brm\s+((?:--?\w+\s+)*)(.*)/s)
  if (rm && /(^|\s)(-\w*[rR]\w*|--recursive)\s/.test(` ${rm[1]}`)) {
    return deleteOf(plainArgs(rm[2]))
  }
  // PowerShell: Remove-Item <path> -Recurse
  const removeItem = command.match(/\bRemove-Item\b([^;|\n]*)/i)
  if (removeItem && /-Recurse\b/i.test(removeItem[1])) {
    return deleteOf(plainArgs(removeItem[1]))
  }

  const sql = [
    ...command.matchAll(/\b(DROP\s+(?:DATABASE|TABLE|SCHEMA)|TRUNCATE(?:\s+TABLE)?)\s+(?:IF\s+EXISTS\s+)?["`]?([\w.]+)/gi),
  ]
  if (sql.length > 0) {
    return {
      what: 'removes database data for good',
      targets: sql.map(match => `${match[1].toUpperCase()} ${match[2]}`),
      isDelete: false,
    }
  }
  const dropdb = command.match(/\bdropdb\s+(.*)/)
  if (dropdb) {
    return { what: 'removes whole databases for good', targets: plainArgs(dropdb[1]), isDelete: false }
  }

  if (/\bgit\s+(?:-C\s+\S+\s+)?reset\s+--hard\b/.test(command)) {
    return { what: 'throws away every uncommitted change in the repository', targets: [], isDelete: false }
  }
  if (/\bgit\s+(?:-C\s+\S+\s+)?clean\s+-\w*f/.test(command)) {
    return { what: 'deletes every file git does not track', targets: [], isDelete: false }
  }
  if (/\bgit\s+(?:-C\s+\S+\s+)?push\b.*(--force\b|--force-with-lease\b|\s-f\b)/.test(command)) {
    return { what: 'overwrites the history on GitHub (force push)', targets: [], isDelete: false }
  }
  const branch = command.match(/\bgit\s+(?:-C\s+\S+\s+)?branch\s+-D\s+(.*)/)
  if (branch) {
    return { what: 'deletes branches even if they were never merged', targets: plainArgs(branch[1]), isDelete: false }
  }
  if (/\bdocker\s+volume\s+(rm|prune)\b|\bdocker[- ]compose\s+down\b.*(-v\b|--volumes\b)/.test(command)) {
    return {
      what: 'deletes Docker volumes, which is where the databases keep their data',
      targets: [],
      isDelete: false,
    }
  }

  return null
}

/** The question shown before a destructive command. `sizes` maps a target to "12 items". */
export function dangerQuestion(command: string, found: Danger, sizes: Record<string, string>): string {
  const shown = found.targets.slice(0, 5).map(target => (sizes[target] ? `${target} (${sizes[target]})` : target))
  const more = found.targets.length > 5 ? ` and ${found.targets.length - 5} more` : ''
  const targets = shown.length > 0 ? ` Affected: ${shown.join(', ')}${more}.` : ''
  const excerpt = command.length > 160 ? `${command.slice(0, 160)}…` : command

  return `Claude wants to run a command that ${found.what}.${targets} Command: ${excerpt} — run it?`
}
