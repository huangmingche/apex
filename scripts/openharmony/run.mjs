#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const result = spawnSync('python3', ['-B', join(directory, 'source.py'), ...args], {
  stdio: 'inherit', env: { ...environment, PYTHONDONTWRITEBYTECODE: '1' },
});
if (result.error) console.error(`OpenHarmony: Python 3.10+ is required: ${result.error.message}`);
process.exitCode = result.status ?? 1;
