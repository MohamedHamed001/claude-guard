import { expect, test } from 'claude-code/testing'

import { danger, dangerQuestion, expectedAccount, folderOf, isPublish, nativePath, parseGhAccounts, runPart } from './logic'

const GH = `github.com
  ✓ Logged in to github.com account MohamedHamed001 (keyring)
  - Active account: true
  - Git operations protocol: https

  ✓ Logged in to github.com account MohamedHamedSeiTech (keyring)
  - Active account: false
`

test('pushes and PR creation are publishing; reading is not', () => {
  expect(isPublish('git push origin main')).toBe(true)
  expect(isPublish('git -C "D:/Projects/x" push')).toBe(true)
  expect(isPublish('gh pr create --fill')).toBe(true)
  expect(isPublish('git status && git log')).toBe(false)
  expect(isPublish('gh pr view 3')).toBe(false)
})

test('the folder is read from git -C or a leading cd', () => {
  expect(folderOf('git -C "D:/Projects/claude focus" push')).toBe('D:/Projects/claude focus')
  expect(folderOf('cd /d/Projects/x && git push')).toBe('/d/Projects/x')
  expect(folderOf('git push')).toBe(null)
})

test('a Git Bash drive path is converted only in a Windows session', () => {
  expect(nativePath('/d/Projects/x', 'D:\\Projects\\y')).toBe('d:/Projects/x')
  expect(nativePath('D:/Projects/x', 'D:/Projects/y')).toBe('D:/Projects/x')
  expect(nativePath('/d/Projects/x', '/home/me/y')).toBe('/d/Projects/x')
})

test('text inside a heredoc is file content, not a command', () => {
  const writesAFile = "cat > notes.md <<'EOF'\nrun git push, then rm -rf build\nEOF"
  expect(isPublish(runPart(writesAFile))).toBe(false)
  expect(danger(runPart(writesAFile))).toBe(null)
  expect(danger(runPart("rm -rf build <<'EOF'\nx\nEOF"))?.targets).toEqual(['build'])
})

test('gh auth status gives every account and the active one', () => {
  expect(parseGhAccounts(GH)).toEqual({ active: 'MohamedHamed001', all: ['MohamedHamed001', 'MohamedHamedSeiTech'] })
})

test('the expected account comes from the repo setting, then from the git identity, else nothing', () => {
  const all = ['MohamedHamed001', 'MohamedHamedSeiTech']
  expect(expectedAccount('SomeoneElse\n', 'whatever', all)).toBe('SomeoneElse')
  expect(expectedAccount('', 'Mohamed Hamed 74424205+MohamedHamed001@users.noreply.github.com', all)).toBe('MohamedHamed001')
  expect(expectedAccount('', 'MohamedHamedSeiTech m@seitech.com', all)).toBe('MohamedHamedSeiTech')
  expect(expectedAccount('', 'Mohamed Hamed me@gmail.com', all)).toBe(null) // no evidence: never blocks
})

test('destructive commands are recognised with what they touch', () => {
  expect(danger('rm -rf build dist')?.targets).toEqual(['build', 'dist'])
  expect(danger('Remove-Item -Recurse -Force "D:/Projects/_delegation-runs"')?.targets).toEqual(['D:/Projects/_delegation-runs'])
  expect(danger('psql -c "DROP DATABASE IF EXISTS reqforge_harness_1; DROP DATABASE reqforge_harness_2"')?.targets).toEqual([
    'DROP DATABASE reqforge_harness_1',
    'DROP DATABASE reqforge_harness_2',
  ])
  expect(danger('git reset --hard HEAD~1')?.what).toContain('uncommitted')
  expect(danger('git push --force origin main')?.what).toContain('force push')
  expect(danger('git branch -D temp-merge')?.targets).toEqual(['temp-merge'])
  expect(danger('docker compose down -v')?.what).toContain('volumes')
})

test('ordinary commands and temp-folder deletes pass without a question', () => {
  expect(danger('rm notes.txt')).toBe(null)
  expect(danger('git push origin main')).toBe(null)
  expect(danger('git status')).toBe(null)
  expect(danger('rm -rf "$TEMP/claude/scratchpad/stale"')).toBe(null)
  expect(danger('rm -rf /tmp/run1 C:/Users/me/AppData/Local/Temp/x')).toBe(null)
  expect(danger('rm -rf /tmp/run1 src')?.targets).toEqual(['/tmp/run1', 'src']) // one real folder: ask
})

test('the question names the effect, the targets with sizes, and the command', () => {
  const found = danger('rm -rf build')!
  const question = dangerQuestion('rm -rf build', found, { build: '12 items at the top level' })
  expect(question).toContain('deletes folders')
  expect(question).toContain('build (12 items at the top level)')
  expect(question).toContain('rm -rf build')
})
