import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmdirSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const OFFICIAL_REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness.git'
const SOURCE_PATH = '.submodules/deepseek-harness'
const MARKER = '.apex-workspace.json'
const WORKSPACE_FORMAT = 'official-source-v2'
const OBJECT_ID = /^[0-9a-f]{40}$/u

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fail(message) {
  throw new Error(`apex: ${message}`)
}

export function cleanEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith('GIT_')))
}

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...cleanEnvironment(), GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function statIfPresent(path) {
  try { return lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function canonicalPath(path) {
  const absolute = resolve(path)
  const suffix = []
  let ancestor = absolute
  while (statIfPresent(ancestor) === undefined) {
    suffix.unshift(ancestor.slice(dirname(ancestor).length + (dirname(ancestor).endsWith(sep) ? 0 : 1)))
    ancestor = dirname(ancestor)
  }
  return resolve(realpathSync(ancestor), ...suffix)
}

/** A generated workspace cannot contain, or sit inside, either source checkout. */
export function assertWorkspaceLocation(repoRoot, target, upstreamPath = join(repoRoot, SOURCE_PATH)) {
  const absolute = resolve(target)
  const entry = statIfPresent(absolute)
  if (entry?.isSymbolicLink()) fail(`workspace must not be a symbolic link: ${absolute}`)
  const canonical = canonicalPath(absolute)
  for (const protectedPath of [repoRoot, upstreamPath]) {
    const protectedCanonical = canonicalPath(protectedPath)
    if (isWithin(protectedCanonical, canonical) || isWithin(canonical, protectedCanonical)) {
      fail(`workspace must be outside the project and upstream checkouts: ${absolute}`)
    }
  }
  return canonical
}

function sourcePath(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || path.includes('\0')
    || isAbsolute(path) || path.split('/').some(part => part === '' || part === '.' || part === '..')
    || path.split('/').some(part => part.toLowerCase() === '.git') || path === MARKER) {
    fail(`invalid path in upstream Git tree: ${JSON.stringify(path)}`)
  }
  return path
}

function regularFile(path, label) {
  const stat = statIfPresent(path)
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file: ${path}`)
  return readFileSync(path)
}

/** Read metadata and file identities directly from the locked official Git tree. */
export function loadProject(repoRoot) {
  const root = realpathSync(repoRoot)
  const lockBytes = regularFile(join(root, 'dsh-source.lock.json'), 'version lock')
  const lock = JSON.parse(lockBytes)
  if (lock.repository !== OFFICIAL_REPOSITORY || lock.referencePath !== SOURCE_PATH
    || !/^dsh-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(lock.tag ?? '')
    || !OBJECT_ID.test(lock.commit ?? '') || !OBJECT_ID.test(lock.tree ?? '')) {
    fail('dsh-source.lock.json must pin an official release commit and tree')
  }
  const metadata = JSON.parse(regularFile(join(root, 'package.json'), 'root package metadata'))
  const version = lock.tag.slice('dsh-v'.length)
  const upstream = metadata.apex?.upstream
  if (metadata.version !== version || upstream?.version !== version
    || upstream?.repository !== lock.repository || upstream?.commit !== lock.commit
    || upstream?.tag !== lock.tag || upstream?.path !== lock.referencePath) {
    fail('root package version and apex.upstream must match dsh-source.lock.json')
  }
  const upstreamPath = join(root, SOURCE_PATH)
  if (!existsSync(join(upstreamPath, '.git'))) fail(`upstream submodule is not initialized: ${upstreamPath}`)
  const upstreamMetadata = JSON.parse(git(upstreamPath, ['show', `${lock.commit}:package.json`]))
  if (upstreamMetadata.version !== version || !/^pnpm@\d+\.\d+\.\d+$/u.test(upstreamMetadata.packageManager ?? '')
    || metadata.packageManager !== upstreamMetadata.packageManager) {
    fail('root package manager and release version must match the locked official package metadata')
  }
  const files = Object.create(null)
  for (const entry of git(upstreamPath, ['ls-tree', '-r', '-z', lock.commit]).split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t')
    const [mode, type, objectId] = entry.slice(0, separator).split(' ')
    const path = sourcePath(entry.slice(separator + 1))
    if (separator < 0 || type !== 'blob' || !['100644', '100755', '120000'].includes(mode) || !OBJECT_ID.test(objectId)) {
      fail(`unsupported upstream Git tree entry: ${path}`)
    }
    files[path] = { mode, objectId }
  }
  if (Object.keys(files).length === 0) fail('locked official Git tree contains no source files')
  return {
    root, lock, files, upstreamPath, packageManager: upstreamMetadata.packageManager,
    sourceId: sha256(Buffer.concat([Buffer.from(`${WORKSPACE_FORMAT}\0`), lockBytes])),
  }
}

/** Read-only checks; Git optional locks are disabled for the upstream checkout. */
export function verifyUpstream(project) {
  const { lock, upstreamPath } = project
  if (!existsSync(join(upstreamPath, '.git'))) fail(`upstream submodule is not initialized: ${upstreamPath}`)
  for (const [revision, expected] of [
    ['HEAD', lock.commit], ['HEAD^{tree}', lock.tree], [`refs/tags/${lock.tag}^{commit}`, lock.commit],
  ]) {
    if (git(upstreamPath, ['rev-parse', '--verify', revision]).trim() !== expected) {
      fail(`upstream ${revision} differs from the version lock`)
    }
  }
  if (git(upstreamPath, ['status', '--porcelain', '--untracked-files=all']).trim() !== '') {
    fail('official upstream checkout has local changes; it must remain clean')
  }
}

export function workspacePath(project, options = {}) {
  const supplied = options.workspaceDir ?? process.env.APEX_WORKSPACE_DIR
  const target = supplied ?? join(options.cacheHome ?? join(homedir(), '.cache/apex/workspaces'),
    sha256(project.root).slice(0, 16), project.sourceId.slice(0, 16))
  if (supplied === '') fail('APEX_WORKSPACE_DIR must not be empty')
  return assertWorkspaceLocation(project.root, target, project.upstreamPath)
}

function verifySources(project, workspace) {
  for (const [path, expected] of Object.entries(project.files)) {
    const absolute = join(workspace, path)
    const stat = statIfPresent(absolute)
    if (stat === undefined) fail(`generated source is missing: ${path}`)
    if (!isWithin(realpathSync(workspace), canonicalPath(dirname(absolute)))) fail(`source parent escapes workspace: ${path}`)
    const mode = stat.isSymbolicLink() ? '120000' : stat.isFile() ? ((stat.mode & 0o111) !== 0 ? '100755' : '100644') : undefined
    const bytes = mode === '120000' ? Buffer.from(readlinkSync(absolute)) : mode === undefined ? Buffer.alloc(0) : readFileSync(absolute)
    const objectId = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (mode !== expected.mode || objectId !== expected.objectId) {
      fail(`generated source differs from the locked official source: ${path}; preserve your edits and regenerate at a new path`)
    }
  }
}

function verifyGitDirectory(workspace) {
  const path = join(workspace, '.git')
  const stat = statIfPresent(path)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`generated Git metadata is not owned by the workspace: ${path}`)
  if (git(workspace, ['rev-parse', '--show-toplevel']).trim() !== realpathSync(workspace)) {
    fail('generated workspace Git root points elsewhere')
  }
}

/** Allow ignored build outputs while rejecting edited or unexpected source files. */
export function verifyWorkspace(project, workspace) {
  assertWorkspaceLocation(project.root, workspace, project.upstreamPath)
  const marker = JSON.parse(regularFile(join(workspace, MARKER), 'workspace ownership marker'))
  if (marker.schemaVersion !== 2 || marker.sourceKind !== 'official' || marker.projectRoot !== project.root || marker.sourceId !== project.sourceId) {
    fail(`existing directory belongs to another project or source revision: ${workspace}`)
  }
  verifyGitDirectory(workspace)
  if (git(workspace, ['rev-parse', '--verify', 'HEAD^{commit}']).trim() !== project.lock.commit) {
    fail('generated workspace HEAD differs from the locked upstream commit')
  }
  verifySources(project, workspace)
  const indexed = new Map(git(workspace, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(entry => {
    const separator = entry.indexOf('\t')
    const [mode, objectId, stage] = entry.slice(0, separator).split(' ')
    return [entry.slice(separator + 1), { mode, objectId, stage }]
  }))
  const unindexed = Object.keys(project.files).filter(path => !indexed.has(path))
  if (unindexed.length > 0) fail(`generated source index is missing files: ${unindexed.slice(0, 5).join(', ')}`)
  const unexpected = git(workspace, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .split('\0').filter(path => path !== '' && path !== MARKER && !Object.hasOwn(project.files, path))
  if (unexpected.length > 0) fail(`generated workspace contains new source files: ${unexpected.slice(0, 5).join(', ')}`)
  for (const [path, expected] of Object.entries(project.files)) {
    const entry = indexed.get(path)
    if (entry.stage !== '0' || entry.mode !== expected.mode || entry.objectId !== expected.objectId) {
      fail(`generated source index differs from the locked official source: ${path}`)
    }
  }
}

/** Assemble a fresh, external checkout. Existing directories are never replaced. */
export function prepareWorkspace(project, options = {}) {
  verifyUpstream(project)
  const target = workspacePath(project, options)
  const existing = statIfPresent(target)
  if (existing !== undefined) {
    if (!existing.isDirectory() || !existsSync(join(target, MARKER))) fail(`refusing to overwrite existing directory: ${target}`)
    verifyWorkspace(project, target)
    return target
  }
  mkdirSync(dirname(target), { recursive: true })
  assertWorkspaceLocation(project.root, target, project.upstreamPath)
  const staging = mkdtempSync(join(dirname(target), '.apex-preparing-'))
  try {
    git(staging, ['-c', 'init.templateDir=', 'init', '--quiet'])
    git(staging, ['config', '--local', 'core.hooksPath', '.git/apex-disabled-hooks'])
    git(staging, ['config', '--local', 'core.autocrlf', 'false'])
    // Read the existing upstream history without copying objects or creating a commit.
    const upstreamObjects = git(project.upstreamPath, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim()
    if (/[\r\n]/u.test(upstreamObjects)) fail('upstream object path cannot contain a newline')
    mkdirSync(join(staging, '.git/objects/info'), { recursive: true })
    writeFileSync(join(staging, '.git/objects/info/alternates'), `${upstreamObjects}\n`, { flag: 'wx' })
    writeFileSync(join(staging, '.git/HEAD'), `${project.lock.commit}\n`)
    const archive = git(project.upstreamPath, ['archive', '--format=tar', project.lock.commit], { encoding: undefined })
    execFileSync('tar', ['-xf', '-', '-C', staging], { input: archive, stdio: ['pipe', 'pipe', 'pipe'] })
    verifySources(project, staging)
    git(staging, ['read-tree', project.lock.commit])
    mkdirSync(join(staging, '.git/info'), { recursive: true })
    writeFileSync(join(staging, '.git/info/exclude'), `${MARKER}\n`, { flag: 'a' })
    writeFileSync(join(staging, MARKER), `${JSON.stringify({
      schemaVersion: 2, sourceKind: 'official', projectRoot: project.root, sourceId: project.sourceId,
      upstreamCommit: project.lock.commit,
    }, null, 2)}\n`, { flag: 'wx' })
    verifyWorkspace(project, staging)
    // Exclusive reservation also protects an empty directory created by another process.
    mkdirSync(target)
    for (const entry of readdirSync(staging)) renameSync(join(staging, entry), join(target, entry))
    rmdirSync(staging)
    return target
  } catch (error) {
    throw new Error(`${error.message}\nPreparation files were preserved outside the project at ${staging}`, { cause: error })
  }
}
