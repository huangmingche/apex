import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  assertWorkspaceLocation, cleanEnvironment, loadProject, prepareWorkspace,
  verifyUpstream, verifyWorkspace,
} from './workspace.mjs'
import { commandFor } from './run.mjs'

const projectRoot = process.env.APEX_TEST_PROJECT_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const upstreamRoot = realpathSync(process.env.APEX_TEST_UPSTREAM ?? join(projectRoot, '.submodules/deepseek-harness'))
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'apex-launcher-test-')))

function fixture(name) {
  const root = join(temporary, name)
  mkdirSync(join(root, '.submodules'), { recursive: true })
  for (const file of ['package.json', 'dsh-source.lock.json']) cpSync(join(projectRoot, file), join(root, file))
  symlinkSync(upstreamRoot, join(root, '.submodules/deepseek-harness'), 'dir')
  return root
}

test('protected source trees cannot be selected as generated workspaces, including symlink aliases', () => {
  const root = fixture('path-guards')
  for (const path of [root, join(root, 'build'), dirname(root), upstreamRoot, join(upstreamRoot, 'build')]) {
    assert.throws(() => assertWorkspaceLocation(root, path, upstreamRoot), /must be outside/u)
  }
  const alias = join(temporary, 'project-alias')
  symlinkSync(root, alias, 'dir')
  assert.throws(() => assertWorkspaceLocation(root, join(alias, 'generated'), upstreamRoot), /must be outside/u)
  assert.throws(() => assertWorkspaceLocation(root, alias, upstreamRoot), /symbolic link/u)
  assert.equal(assertWorkspaceLocation(root, join(temporary, 'new-external'), upstreamRoot), join(temporary, 'new-external'))
})

test('root release and package-manager metadata must match the official source', () => {
  const root = fixture('metadata')
  const path = join(root, 'package.json')
  const metadata = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...metadata, version: '0.0.0' }))
  assert.throws(() => loadProject(root), /must match dsh-source.lock.json/u)
  writeFileSync(path, JSON.stringify({ ...metadata, packageManager: 'pnpm@1.0.0' }))
  assert.throws(() => loadProject(root), /must match the locked official package metadata/u)
})

test('pnpm root commands forward arguments without installing dependencies or including child packages', () => {
  const root = fixture('pnpm-entry')
  cpSync(join(projectRoot, 'pnpm-workspace.yaml'), join(root, 'pnpm-workspace.yaml'))
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...metadata, scripts: { probe: 'node probe.cjs' } }))
  writeFileSync(join(root, 'probe.cjs'), 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }))\n')
  const child = join(root, 'packages/example/package')
  mkdirSync(child, { recursive: true })
  writeFileSync(join(child, 'package.json'), JSON.stringify({ name: 'not-a-root-workspace-member', private: true }))
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const env = cleanEnvironment()
  delete env.pnpm_config_verify_deps_before_run
  delete env.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN
  const result = JSON.parse(execFileSync(pnpm, ['run', 'probe', '--maxWorkers=4'], { cwd: root, env, encoding: 'utf8' }))
  assert.deepEqual(result, { args: ['--maxWorkers=4'], cwd: root })
  const members = JSON.parse(execFileSync(pnpm, ['list', '-r', '--depth=-1', '--json'], { cwd: root, env, encoding: 'utf8' }))
  assert.deepEqual(members.map(member => member.path), [root])
  assert.equal(existsSync(join(root, 'node_modules')), false)
  assert.equal(existsSync(join(root, 'pnpm-lock.yaml')), false)
})

test('existing unrelated directories and their files remain untouched', () => {
  const root = fixture('existing')
  const project = loadProject(root)
  const target = join(temporary, 'user-owned-directory')
  mkdirSync(target)
  writeFileSync(join(target, 'keep.txt'), 'user-owned data\n')
  assert.throws(() => prepareWorkspace(project, { workspaceDir: target }), /refusing to overwrite/u)
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'user-owned data\n')
})

test('old generation markers cannot be reused or overwritten', () => {
  const root = fixture('old-generation')
  const project = loadProject(root)
  const target = join(temporary, 'old-output')
  mkdirSync(target)
  const marker = JSON.stringify({ schemaVersion: 1, projectRoot: project.root, sourceId: project.sourceId })
  writeFileSync(join(target, '.apex-workspace.json'), marker)
  writeFileSync(join(target, 'keep.txt'), 'previous generation data\n')
  assert.throws(() => prepareWorkspace(project, { workspaceDir: target }), /another project or source revision/u)
  assert.equal(readFileSync(join(target, '.apex-workspace.json'), 'utf8'), marker)
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'previous generation data\n')
})

test('materialized source is reproducible and edits cannot be overwritten or hidden in the index', async t => {
  const root = fixture('full-source')
  const project = loadProject(root)
  const outer = join(temporary, 'unrelated-git-repository')
  mkdirSync(outer)
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '--quiet', outer], { env: cleanEnvironment() })
  writeFileSync(join(outer, 'user-file'), 'outside workspace\n')
  const target = join(outer, 'generated')
  assert.equal(prepareWorkspace(project, { workspaceDir: target }), target)
  verifyWorkspace(project, target)
  assert.equal(prepareWorkspace(project, { workspaceDir: target }), target)
  assert.equal(readFileSync(join(outer, 'user-file'), 'utf8'), 'outside workspace\n')
  assert.equal(execFileSync('git', ['-C', outer, 'ls-files'], { encoding: 'utf8', env: cleanEnvironment() }), '')

  await t.test('generated source retains official metadata, branding and home defaults', () => {
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')),
      JSON.parse(execFileSync('git', ['-C', upstreamRoot, 'show', `${project.lock.commit}:package.json`], { encoding: 'utf8', env: cleanEnvironment() })))
    assert.match(readFileSync(join(target, 'packages/client/ui-renderer/src/client/DocumentTitle.tsx'), 'utf8'),
      /const DEFAULT_CLIENT_TITLE = 'DSH Local Build'/u)
    assert.match(readFileSync(join(target, 'packages/util/home-paths/src/index.ts'), 'utf8'),
      /export const DSH_HOME_DIR_NAME = '\.dsh'/u)
    assert.equal(execFileSync('git', ['-C', target, 'diff', '--name-only', 'HEAD'], { encoding: 'utf8', env: cleanEnvironment() }), '')
    assert.equal(existsSync(join(root, 'patches')), false)
  })

  await t.test('HEAD resolves to the locked upstream history and changed HEAD is rejected', () => {
    const git = args => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8', env: cleanEnvironment() }).trim()
    assert.equal(git(['rev-parse', '--verify', 'HEAD^{commit}']), project.lock.commit)
    assert.equal(git(['rev-parse', '--verify', 'HEAD^{tree}']), project.lock.tree)
    assert.equal(JSON.parse(git(['show', 'HEAD:package.json'])).version, project.lock.tag.slice('dsh-v'.length))
    const originalHead = readFileSync(join(target, '.git/HEAD'))
    writeFileSync(join(target, '.git/HEAD'), `${git(['rev-parse', 'HEAD^'])}\n`)
    assert.throws(() => prepareWorkspace(project, { workspaceDir: target }), /HEAD differs from the locked upstream commit/u)
    writeFileSync(join(target, '.git/HEAD'), originalHead)
    verifyWorkspace(project, target)
  })

  await t.test('edited source is rejected and preserved', () => {
    const path = join(target, 'README.md')
    const original = readFileSync(path)
    writeFileSync(path, 'local edit that must not be overwritten\n')
    assert.throws(() => prepareWorkspace(project, { workspaceDir: target }), /differs from the locked official source/u)
    assert.equal(readFileSync(path, 'utf8'), 'local edit that must not be overwritten\n')
    writeFileSync(path, original)
    verifyWorkspace(project, target)
  })

  await t.test('new source is rejected even after git add', () => {
    const extra = join(target, 'apex-unexpected-source.ts')
    writeFileSync(extra, 'export const unexpected = true\n')
    assert.throws(() => verifyWorkspace(project, target), /contains new source files/u)
    execFileSync('git', ['-C', target, 'add', 'apex-unexpected-source.ts'], { env: cleanEnvironment() })
    assert.throws(() => verifyWorkspace(project, target), /contains new source files/u)
    execFileSync('git', ['-C', target, 'update-index', '--force-remove', 'apex-unexpected-source.ts'], { env: cleanEnvironment() })
    unlinkSync(extra)
    verifyWorkspace(project, target)
  })

  await t.test('missing index entries cannot hide source from checks', () => {
    execFileSync('git', ['-C', target, 'update-index', '--force-remove', 'README.md'], { env: cleanEnvironment() })
    assert.throws(() => verifyWorkspace(project, target), /index is missing files/u)
    execFileSync('git', ['-C', target, 'add', 'README.md'], { env: cleanEnvironment() })
    verifyWorkspace(project, target)
  })

  await t.test('index content must also match the official tree', () => {
    const path = join(target, 'README.md')
    const original = readFileSync(path)
    writeFileSync(path, 'staged source change\n')
    execFileSync('git', ['-C', target, 'add', 'README.md'], { env: cleanEnvironment() })
    writeFileSync(path, original)
    assert.throws(() => verifyWorkspace(project, target), /index differs from the locked official source/u)
    execFileSync('git', ['-C', target, 'add', 'README.md'], { env: cleanEnvironment() })
    verifyWorkspace(project, target)
  })

  await t.test('ignored build outputs are allowed', () => {
    mkdirSync(join(target, '.dsh-build'), { recursive: true })
    writeFileSync(join(target, '.dsh-build/test-generated-output.json'), '{}\n')
    verifyWorkspace(project, target)
  })

  await t.test('CLI and web preserve the caller project; build and install use generated source', () => {
    const bin = join(target, 'apps/cli/lib/bin.js')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }))\n')
    const caller = join(temporary, 'caller-project')
    mkdirSync(caller)
    writeFileSync(join(caller, 'session.jsonl'), '')
    const env = { ...process.env, INIT_CWD: caller, GIT_DIR: '/must/not/be/inherited' }
    for (const task of ['cli', 'dsh', 'web']) {
      const command = commandFor(project, target, task, ['--session', 'session.jsonl'], env, root)
      const output = JSON.parse(execFileSync(command.command, command.args, { cwd: command.cwd, env: command.env, encoding: 'utf8' }))
      assert.equal(output.cwd, caller)
      assert.deepEqual(output.args, [...(task === 'web' ? ['web'] : []), '--session', 'session.jsonl'])
      assert.equal(command.env.GIT_DIR, undefined)
    }
    const build = commandFor(project, target, 'build', [], env, caller)
    assert.equal(build.cwd, target)
    assert.equal(build.command, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    assert.deepEqual(build.args, ['run', 'build'])
    assert.equal(build.env.DSH_CLIENT_COMMIT_HASH, project.lock.commit)
    assert.equal(build.env.pnpm_config_verify_deps_before_run, 'false')
    const install = commandFor(project, target, 'install', [], env, caller)
    assert.equal(install.cwd, target)
    assert.equal(install.env.CI, 'true')
    assert.deepEqual(install.args, ['install', '--frozen-lockfile'])
    const execute = commandFor(project, target, 'exec', ['node', '--version'], env, caller)
    assert.deepEqual(execute.args, ['exec', 'node', '--version'])
    verifyWorkspace(project, target)
  })
  verifyUpstream(project)
})
