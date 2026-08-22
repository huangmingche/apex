import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { verifyPackageLayout } from './package-layout.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'apex-package-layout-'));
  mkdirSync(join(root, 'packages'));
  return root;
}

function write(root, path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

test('documentation-only packages directory needs no placeholder packages', () => {
  const root = fixture();
  write(root, 'packages/README.md', '# Apex 自有包\n');
  write(root, 'packages/README.en.md', '# Apex packages\n');
  assert.deepEqual(verifyPackageLayout(root), []);
});

test('grouped Apex packages accept distinct names and do not require TypeScript for bundles', () => {
  const root = fixture();
  write(root, 'packages/client/README.md', '# Client\n');
  write(root, 'packages/client/ui-brand/package.json', '{"name":"@example/apex-ui-brand"}');
  write(root, 'packages/bundle/base/package.json', '{"name":"apex-base"}');
  assert.deepEqual(verifyPackageLayout(root).map(pkg => pkg.name).sort(), ['@example/apex-ui-brand', 'apex-base']);
});

test('flat packages and group-level source are rejected', () => {
  for (const path of ['packages/package.json', 'packages/flat/package.json', 'packages/client/index.ts']) {
    const root = fixture();
    write(root, path, '{}');
    assert.throws(() => verifyPackageLayout(root), /only package directories and Markdown/u);
  }
});

test('nested package directories must have readable valid manifests and names', () => {
  for (const content of [undefined, '{', '{}', '{"name":"bad name"}']) {
    const root = fixture();
    mkdirSync(join(root, 'packages/client/ui-brand'), { recursive: true });
    if (content !== undefined) write(root, 'packages/client/ui-brand/package.json', content);
    assert.throws(() => verifyPackageLayout(root), /package\.json.*(?:valid|own)|own regular package\.json/u);
  }
});

test('official and duplicate package identities are rejected', () => {
  const upstream = fixture();
  write(upstream, 'packages/client/ui-brand/package.json', '{"name":"@deepseek-ai/dsh-client-ui-brand-official"}');
  assert.throws(() => verifyPackageLayout(upstream), /uses the upstream name/u);
  const duplicate = fixture();
  write(duplicate, 'packages/client/one/package.json', '{"name":"apex-brand"}');
  write(duplicate, 'packages/client/two/package.json', '{"name":"apex-brand"}');
  assert.throws(() => verifyPackageLayout(duplicate), /Duplicate Apex package name/u);
});

test('group and package links cannot substitute an upstream checkout', () => {
  for (const path of ['packages/client', 'packages/client/ui-brand']) {
    const root = fixture();
    const upstream = join(root, '.submodules/official-package');
    mkdirSync(upstream, { recursive: true });
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(upstream, join(root, path), 'dir');
    assert.throws(() => verifyPackageLayout(root), /only package directories and Markdown/u);
  }
});

test('the former plugins directory is rejected', () => {
  const root = fixture();
  mkdirSync(join(root, 'plugins'));
  assert.throws(() => verifyPackageLayout(root), /old root plugins/u);
});
