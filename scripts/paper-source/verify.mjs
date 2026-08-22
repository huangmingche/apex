#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_PATH = '.submodules/deepseek-harness-paper'
const SOURCE_NAME = 'deepseek-harness-paper'
const REPOSITORY = 'https://github.com/cordiverse/paper.git'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function require(condition, message) {
  if (!condition) throw new Error(`Paper: ${message}`)
}

function git(cwd, ...args) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
  })
}

function stat(path) {
  try { return lstatSync(path) } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function singleConfig(cwd, args, key, expected) {
  let values
  try { values = git(cwd, 'config', ...args, '--null', '--get-all', key).slice(0, -1).split('\0') } catch {
    throw new Error(`Paper: missing configuration ${key}`)
  }
  require(values.length === 1 && values[0] === expected, `${key} must be exactly ${expected}`)
}

/** Validate the recorded Paper checkout without fetching, changing, or repairing it. */
export function verifyPaper(repoRoot = ROOT) {
  const root = realpathSync(repoRoot)
  require(realpathSync(git(root, 'rev-parse', '--show-toplevel').trim()) === root, 'expected the Apex repository root')
  const modules = join(root, '.gitmodules')
  require(stat(modules)?.isFile() && !stat(modules).isSymbolicLink(), '.gitmodules must be a regular file')
  for (const args of [['--file', modules], ['--blob', ':.gitmodules']]) {
    singleConfig(root, args, `submodule.${SOURCE_NAME}.path`, SOURCE_PATH)
    singleConfig(root, args, `submodule.${SOURCE_NAME}.url`, REPOSITORY)
  }

  // Like the OpenHarmony validator, use the index so a staged version update can be checked before committing.
  const entries = git(root, 'ls-files', '--stage', '-z', '--', SOURCE_PATH).split('\0').filter(Boolean)
  const match = entries.length === 1 && /^160000 ([0-9a-f]{40}) 0\t(.+)$/u.exec(entries[0])
  require(match && match[2] === SOURCE_PATH, 'the index must contain one stage-0 Paper Git commit pointer')
  const commit = match[1]

  for (const relative of ['.submodules', SOURCE_PATH]) {
    const entry = stat(join(root, relative))
    require(entry?.isDirectory() && !entry.isSymbolicLink(), `${relative} must be an initialized directory, not a symbolic link`)
  }
  const source = join(root, SOURCE_PATH)
  const metadata = stat(join(source, '.git'))
  require(metadata && !metadata.isSymbolicLink() && (metadata.isFile() || metadata.isDirectory()), 'Paper submodule is not initialized')
  require(realpathSync(git(source, 'rev-parse', '--show-toplevel').trim()) === source, 'Paper must have its own Git worktree')
  require(realpathSync(git(source, 'rev-parse', '--absolute-git-dir').trim())
    !== realpathSync(git(root, 'rev-parse', '--absolute-git-dir').trim()), 'Paper must have its own Git metadata')
  require(git(source, 'rev-parse', '--is-inside-work-tree').trim() === 'true', 'Paper must be a Git worktree')
  singleConfig(source, [], 'remote.origin.url', REPOSITORY)
  let type
  try { type = git(source, 'cat-file', '-t', commit).trim() } catch {
    throw new Error(`Paper: recorded commit is unavailable: ${commit}`)
  }
  require(type === 'commit', 'the recorded Paper object must be a commit')
  require(git(source, 'rev-parse', '--verify', 'HEAD').trim() === commit, 'Paper HEAD differs from the recorded commit')
  require(!git(source, 'ls-files', '-v', '-z').split('\0').some(entry => /^[a-zS]/u.test(entry)),
    'Paper index must not hide files with assume-unchanged or skip-worktree flags')
  require(git(source, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none') === '',
    'Paper checkout has staged, tracked, or untracked changes')
  require(git(source, 'ls-files', '--others', '-z') === '', 'Paper checkout contains untracked or ignored files')
  return { path: SOURCE_PATH, repository: REPOSITORY, commit }
}

function isMain() {
  try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
}

if (isMain()) {
  try {
    require(process.argv.length <= 3, 'usage: node scripts/paper-source/verify.mjs [repository-root]')
    console.log(JSON.stringify({ ok: true, ...verifyPaper(process.argv[2]) }, null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
