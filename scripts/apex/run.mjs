#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanEnvironment, loadProject, prepareWorkspace } from './workspace.mjs'

export function commandFor(project, workspace, task, args, environment = process.env, cwd = process.cwd()) {
  const env = {
    ...cleanEnvironment(environment),
    DSH_CLIENT_COMMIT_HASH: project.lock.commit,
    // Dependency installation belongs to install:runtime, never an implicit script preflight.
    pnpm_config_verify_deps_before_run: 'false',
  }
  if (['cli', 'dsh', 'web'].includes(task)) {
    const bin = join(workspace, 'apps/cli/lib/bin.js')
    if (!existsSync(bin)) throw new Error('Apex CLI has not been built; run pnpm run build first')
    return {
      command: process.execPath,
      args: [bin, ...(task === 'web' ? ['web'] : []), ...args],
      cwd: environment.INIT_CWD ?? cwd,
      env,
    }
  }
  const pnpmArgs = task === 'install' ? ['install', ...args, '--frozen-lockfile']
    : task === 'exec' ? ['exec', ...args] : ['run', task, ...args]
  if (task === 'install') env.CI = 'true'
  return {
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: pnpmArgs,
    cwd: workspace,
    env,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [task, ...args] = process.argv.slice(2)
    if (task === undefined || task.startsWith('-')) throw new Error('Usage: node scripts/apex/run.mjs <install|build|test|cli|web|exec|script> [arguments]')
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const project = loadProject(root)
    const workspace = prepareWorkspace(project)
    const invocation = commandFor(project, workspace, task, args)
    const result = spawnSync(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.signal) process.kill(process.pid, result.signal)
    else process.exitCode = result.status ?? 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
