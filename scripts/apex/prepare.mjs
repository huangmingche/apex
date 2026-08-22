#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProject, prepareWorkspace } from './workspace.mjs'

try {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/apex/prepare.mjs')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  console.log(prepareWorkspace(loadProject(root)))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
