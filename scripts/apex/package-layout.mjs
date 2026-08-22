import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

function statIfPresent(path) {
  try { return lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Check the two-level layout without importing packages or traversing source checkouts. */
export function verifyPackageLayout(root) {
  if (statIfPresent(join(root, 'plugins'))) {
    throw new Error('Use packages/<group>/<pkg>/ for Apex packages; the old root plugins/ directory must be absent.');
  }
  const packagesRoot = join(root, 'packages');
  const packagesStat = statIfPresent(packagesRoot);
  if (!packagesStat?.isDirectory() || packagesStat.isSymbolicLink()) {
    throw new Error('packages/ must be a local directory containing Apex-owned packages.');
  }
  const packages = [];
  const names = new Set();
  function entries(container) {
    return readdirSync(container, { withFileTypes: true }).filter(entry => {
      if (entry.isFile() && entry.name.endsWith('.md')) return false;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`${relative(root, container)}/ may contain only package directories and Markdown documentation; found ${entry.name}.`);
      }
      return true;
    });
  }
  for (const group of entries(packagesRoot)) {
    const groupPath = join(packagesRoot, group.name);
    for (const entry of entries(groupPath)) {
      const packagePath = join(groupPath, entry.name);
      const manifestPath = join(packagePath, 'package.json');
      const manifestStat = statIfPresent(manifestPath);
      if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
        throw new Error(`${relative(root, packagePath)}/ must contain its own regular package.json.`);
      }
      let manifest;
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch {
        throw new Error(`${relative(root, manifestPath)} must contain valid JSON.`);
      }
      const name = manifest?.name;
      if (typeof name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
        throw new Error(`${relative(root, manifestPath)} must declare a valid package name.`);
      }
      if (name.startsWith('@deepseek-ai/')) {
        throw new Error(`${relative(root, manifestPath)} uses the upstream name ${name}; Apex packages must use independently owned names.`);
      }
      if (names.has(name)) throw new Error(`Duplicate Apex package name: ${name}.`);
      names.add(name);
      packages.push({ name, path: relative(root, packagePath) });
    }
  }
  return packages;
}
