#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, verifyUpstream } from '../apex/workspace.mjs';
import { verifyPackageLayout } from '../apex/package-layout.mjs';
import { verifyPaper } from '../paper-source/verify.mjs';

const root = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)) + '/../..');
try {
  const project = loadProject(root);
  verifyUpstream(project);
  verifyPaper(root);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.workspaces || manifest.dependencies || manifest.devDependencies) {
    throw new Error('The root package must only expose Apex scripts, without upstream workspace dependencies.');
  }
  // Keep the root as a command entry point; all upstream packages belong to the external workspace.
  const pnpmConfig = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').trim().split(/\r?\n/u).map(line => line.trim());
  if (JSON.stringify(pnpmConfig) !== JSON.stringify(['packages:', "- '.'", 'verifyDepsBeforeRun: false'])) {
    throw new Error('Root pnpm configuration must select only the root package and disable automatic dependency installation.');
  }
  const forbidden = ['apps', 'vendor', 'native', 'python', 'examples', 'website', 'patches', 'node_modules', '.dsh-build', '.artifacts', 'dist', 'lib', 'pnpm-lock.yaml'];
  const present = forbidden.filter(name => existsSync(join(root, name)));
  if (present.length) throw new Error(`Unsupported source layout or generated output found in the project root: ${present.join(', ')}`);
  const packages = verifyPackageLayout(root);
  const openharmony = spawnSync(process.execPath, [join(root, 'scripts/openharmony/run.mjs'), 'lock'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (openharmony.error) throw openharmony.error;
  if (openharmony.status !== 0) throw new Error(`OpenHarmony version-lock check failed (${openharmony.signal ?? openharmony.status}).`);
  console.log(`OK Apex: locked upstream is clean, runtime uses official source, and ${packages.length} Apex package(s) follow packages/<group>/<pkg>/.`);
} catch (error) {
  console.error(`FAIL Apex: ${error.message}`);
  process.exitCode = 1;
}
