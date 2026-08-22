import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { verifyPaper } from './verify.mjs'

const PAPER = '.submodules/deepseek-harness-paper'
const OFFICIAL = 'https://github.com/cordiverse/paper.git'
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'apex-paper-test-')))
const globalConfig = join(temporary, 'empty-gitconfig')
writeFileSync(globalConfig, '')
const environment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd, args, input) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd, input, encoding: 'utf8', env: environment, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function fixture() {
  const root = mkdtempSync(join(temporary, 'repository-'))
  const source = join(root, PAPER)
  mkdirSync(source, { recursive: true })
  for (const path of [root, source]) {
    git(path, ['-c', 'init.templateDir=', 'init', '--quiet'])
    git(path, ['config', 'user.name', 'Apex test'])
    git(path, ['config', 'user.email', 'apex-test@example.invalid'])
    git(path, ['config', 'core.autocrlf', 'false'])
  }
  writeFileSync(join(source, 'README.md'), '# Paper\n')
  writeFileSync(join(source, '.gitignore'), 'ignored.log\n')
  git(source, ['add', '.'])
  git(source, ['commit', '--quiet', '-m', 'First paper'])
  const first = git(source, ['rev-parse', 'HEAD'])
  writeFileSync(join(source, 'README.md'), '# Paper\n\nUpdated reference.\n')
  git(source, ['commit', '--quiet', '-am', 'Update paper'])
  const latest = git(source, ['rev-parse', 'HEAD'])
  git(source, ['remote', 'add', 'origin', OFFICIAL])
  writeFileSync(join(root, '.gitmodules'), `[submodule "deepseek-harness-paper"]\n\tpath = ${PAPER}\n\turl = ${OFFICIAL}\n`)
  git(root, ['add', '.gitmodules'])
  const pointTo = commit => git(root, ['update-index', '--add', '--cacheinfo', '160000', commit, PAPER])
  pointTo(latest)
  return { root, source, first, latest, pointTo }
}

test('both historical and updated Paper pointers validate without hardcoded versions or writes', () => {
  const f = fixture()
  const metadata = ['HEAD', 'index', 'config'].map(name => join(f.source, '.git', name))
  const before = metadata.map(path => readFileSync(path))
  assert.deepEqual(verifyPaper(f.root), { path: PAPER, repository: OFFICIAL, commit: f.latest })
  metadata.forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]))
  git(f.source, ['checkout', '--quiet', '--detach', f.first])
  f.pointTo(f.first)
  assert.equal(verifyPaper(f.root).commit, f.first)
})

test('a normal absorbed Git submodule with a .git file validates', () => {
  const f = fixture()
  git(f.root, ['submodule', 'absorbgitdirs', '--', PAPER])
  assert.match(readFileSync(join(f.source, '.git'), 'utf8'), /^gitdir: /u)
  assert.equal(verifyPaper(f.root).commit, f.latest)
})

test('a missing, non-gitlink, or conflicted root index entry cannot pass', async t => {
  await t.test('missing pointer', () => {
    const f = fixture()
    git(f.root, ['update-index', '--force-remove', PAPER])
    assert.throws(() => verifyPaper(f.root), /one stage-0 Paper Git commit pointer/u)
  })
  await t.test('ordinary file instead of submodule', () => {
    const f = fixture()
    const blob = git(f.root, ['hash-object', '-w', '--stdin'], 'not a submodule\n')
    git(f.root, ['update-index', '--add', '--cacheinfo', '100644', blob, PAPER])
    assert.throws(() => verifyPaper(f.root), /one stage-0 Paper Git commit pointer/u)
  })
  await t.test('unresolved conflict', () => {
    const f = fixture()
    git(f.root, ['update-index', '--force-remove', PAPER])
    git(f.root, ['update-index', '--index-info'], `160000 ${f.first} 1\t${PAPER}\n160000 ${f.latest} 2\t${PAPER}\n160000 ${f.first} 3\t${PAPER}\n`)
    assert.throws(() => verifyPaper(f.root), /one stage-0 Paper Git commit pointer/u)
  })
})

test('the Paper origin and both working and indexed source declarations must match', async t => {
  for (const location of ['origin', 'working modules', 'indexed modules', 'duplicate URL', 'URL with extra spaces', 'wrong path']) {
    await t.test(location, () => {
      const f = fixture()
      const modules = join(f.root, '.gitmodules')
      if (location === 'origin') git(f.source, ['remote', 'set-url', 'origin', 'https://example.invalid/paper.git'])
      else if (location === 'URL with extra spaces') git(f.root, ['config', '--file', modules, 'submodule.deepseek-harness-paper.url', ` ${OFFICIAL} `])
      else if (location === 'wrong path') git(f.root, ['config', '--file', modules, 'submodule.deepseek-harness-paper.path', '.submodules/another-paper'])
      else if (location === 'duplicate URL') git(f.root, ['config', '--file', modules, '--add', 'submodule.deepseek-harness-paper.url', OFFICIAL])
      else {
        const original = readFileSync(modules)
        git(f.root, ['config', '--file', modules, 'submodule.deepseek-harness-paper.url', 'https://example.invalid/paper.git'])
        if (location === 'indexed modules') {
          git(f.root, ['add', '.gitmodules'])
          writeFileSync(modules, original)
        }
      }
      assert.throws(() => verifyPaper(f.root), /must be exactly/u)
    })
  }
})

test('missing commit objects, non-commits, and mismatched HEAD are rejected', async t => {
  await t.test('unavailable object', () => {
    const f = fixture()
    f.pointTo('a'.repeat(40))
    assert.throws(() => verifyPaper(f.root), /recorded commit is unavailable/u)
  })
  await t.test('blob instead of commit', () => {
    const f = fixture()
    f.pointTo(git(f.source, ['hash-object', '-w', '--stdin'], 'not a commit\n'))
    assert.throws(() => verifyPaper(f.root), /object must be a commit/u)
  })
  await t.test('wrong checkout', () => {
    const f = fixture()
    git(f.source, ['checkout', '--quiet', '--detach', f.first])
    assert.throws(() => verifyPaper(f.root), /HEAD differs/u)
  })
})

test('uninitialized directories cannot silently use the parent repository', () => {
  const f = fixture()
  renameSync(join(f.source, '.git'), join(temporary, `saved-git-${f.latest}-${Date.now()}`))
  assert.throws(() => verifyPaper(f.root), /not initialized/u)
})

test('a .git file cannot reuse the parent repository metadata', () => {
  const f = fixture()
  renameSync(join(f.source, '.git'), join(mkdtempSync(join(temporary, 'saved-metadata-')), 'git'))
  writeFileSync(join(f.source, '.git'), `gitdir: ${join(f.root, '.git')}\n`)
  assert.throws(() => verifyPaper(f.root), /own Git metadata/u)
})

test('source, parent-directory, and metadata symlinks cannot redirect validation', async t => {
  for (const part of [PAPER, '.submodules', `${PAPER}/.git`]) {
    await t.test(part, () => {
      const f = fixture()
      const path = join(f.root, part)
      const outside = join(mkdtempSync(join(temporary, 'redirect-')), 'target')
      renameSync(path, outside)
      symlinkSync(outside, path, 'dir')
      assert.throws(() => verifyPaper(f.root), /symbolic link|not initialized/u)
    })
  }
})

test('tracked, staged, untracked, and ignored changes are rejected and left untouched', async t => {
  for (const kind of ['tracked', 'staged', 'untracked', 'ignored']) {
    await t.test(kind, () => {
      const f = fixture()
      const path = join(f.source, kind === 'untracked' ? 'extra.md' : kind === 'ignored' ? 'ignored.log' : 'README.md')
      writeFileSync(path, 'preserve this local change\n')
      if (kind === 'staged') git(f.source, ['add', 'README.md'])
      assert.throws(() => verifyPaper(f.root), /checkout (has|contains)/u)
      assert.equal(readFileSync(path, 'utf8'), 'preserve this local change\n')
    })
  }
})

test('index flags cannot hide changed source files', async t => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    await t.test(flag, () => {
      const f = fixture()
      git(f.source, ['update-index', flag, 'README.md'])
      writeFileSync(join(f.source, 'README.md'), 'hidden edit\n')
      assert.throws(() => verifyPaper(f.root), /index must not hide files/u)
    })
  }
})

test('inherited Git environment cannot redirect the repository or index', () => {
  const f = fixture()
  const poison = { GIT_DIR: join(temporary, 'missing-git'), GIT_WORK_TREE: temporary, GIT_INDEX_FILE: join(temporary, 'missing-index') }
  const saved = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]))
  try {
    Object.assign(process.env, poison)
    assert.equal(verifyPaper(f.root).commit, f.latest)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('CLI returns machine-readable success and a failing exit code for a bad checkout', () => {
  const f = fixture()
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'verify.mjs')
  const good = spawnSync(process.execPath, [cli, f.root], { encoding: 'utf8', env: environment })
  assert.equal(good.status, 0, good.stderr)
  assert.deepEqual(JSON.parse(good.stdout), { ok: true, path: PAPER, repository: OFFICIAL, commit: f.latest })
  git(f.source, ['checkout', '--quiet', '--detach', f.first])
  const bad = spawnSync(process.execPath, [cli, f.root], { encoding: 'utf8', env: environment })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /HEAD differs/u)
})

test('a symlinked CLI entry still validates and reports failures', () => {
  const f = fixture()
  const alias = join(mkdtempSync(join(temporary, 'cli-alias-')), 'verify.mjs')
  symlinkSync(join(dirname(fileURLToPath(import.meta.url)), 'verify.mjs'), alias, 'file')
  const good = spawnSync(process.execPath, [alias, f.root], { encoding: 'utf8', env: environment })
  assert.equal(good.status, 0, good.stderr)
  assert.equal(JSON.parse(good.stdout).commit, f.latest)
  writeFileSync(join(f.source, 'README.md'), 'local edit\n')
  const bad = spawnSync(process.execPath, [alias, f.root], { encoding: 'utf8', env: environment })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /checkout has/u)
})
