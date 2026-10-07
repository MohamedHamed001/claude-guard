# claude-guard

A plugin for [Claude Code](https://docs.claude.com/en/docs/claude-code): **guard**.

Two checks on every shell command Claude runs, before it runs:

1. **Wrong GitHub account.** A `git push` or `gh pr create` is refused when the active `gh` account is not the one the repository is pushed with.
2. **Destructive commands.** A recursive delete, a `DROP DATABASE`, a hard reset, a force push and the like open a dialog that says what would be removed, with **Run it** and **Cancel**.

Part of [claude-mods](https://github.com/MohamedHamed001/claude-mods), which lists this plugin and its siblings.

## Install

```
/plugin marketplace add MohamedHamed001/claude-guard
/plugin install guard@claude-guard
```

Then start a new session: a session reads its plugins once, when it starts. Update later with `/plugin marketplace update claude-guard`.

## Requirements

- **Claude Code 2.1.28x or newer.** The plugin uses function hooks (TypeScript modules the app loads), which older versions do not run.
- **Windows, macOS or Linux.** Developed on Windows; macOS has not been tested yet.
- The account check needs the [GitHub CLI](https://cli.github.com/) (`gh`) with two or more accounts signed in. With one account there is nothing to mix up, and the check stays silent.

## What it does

### The account check

If you keep a work account and a personal account in `gh`, a push goes out as whichever one is active. The guard works out which account a repository expects, and refuses the push when another one is active. Claude receives the reason and the exact command to switch:

```
gh auth switch --hostname github.com --user <expected account>
```

How the expected account is found, in order:

1. The repository says so itself: `git config guard.account <login>`.
2. Otherwise, a signed-in account whose login appears in the repository's `user.name` or `user.email`. A GitHub no-reply email such as `74424205+MohamedHamed001@users.noreply.github.com` names its account.
3. No evidence either way: the push runs. The guard only blocks when it has a reason.

### The destructive-command dialog

| Command | What the dialog says |
| --- | --- |
| `rm -r`, `rm -rf`, `Remove-Item -Recurse` | deletes folders and everything inside them, with each target and how many items it holds |
| `DROP DATABASE`, `DROP TABLE`, `DROP SCHEMA`, `TRUNCATE`, `dropdb` | removes database data for good, with each name |
| `git reset --hard` | throws away every uncommitted change |
| `git clean -f` | deletes every file git does not track |
| `git push --force` | overwrites the history on GitHub |
| `git branch -D` | deletes branches even if they were never merged |
| `docker volume rm`, `docker compose down -v` | deletes Docker volumes |

Closing the dialog counts as Cancel. Deletes that only touch temp or scratchpad folders are not asked about.

The patterns are plain regular expressions in `hooks/logic.ts`. They read the command as text, so a delete hidden inside a script file or a variable is not seen.

## Developing

```
claude plugin validate .
claude plugin test .
```

`hooks/logic.ts` holds the rules as plain functions; `hooks/register.ts` runs `gh` and `git` and shows the dialog.

## Licence

MIT. See [LICENSE](LICENSE).
