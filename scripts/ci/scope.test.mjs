import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyScope } from './scope.mjs';

const PAPER = '.submodules/deepseek-harness-paper';
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'apex-ci-scope-'));
  const git = (args, input) => execFileSync('git', [
    '-c', 'user.name=Apex fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    ...args,
  ], { cwd: root, input, encoding: 'utf8', env: { ...CLEAN_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  const empty = git(['mktree'], '');
  const oldPaper = git(['commit-tree', empty], 'Paper before\n');
  const newPaper = git(['commit-tree', empty], 'Paper after\n');
  function write(path, content) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    git(['add', '--', path]);
  }
  function link(sha = newPaper, path = PAPER) {
    git(['update-index', '--add', '--cacheinfo', `160000,${sha},${path}`]);
  }
  function commit(message) {
    git(['commit', '--quiet', '--allow-empty', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  }
  write('README.md', '# Fixture\n');
  write('.gitmodules', `[submodule "deepseek-harness-paper"]\n\tpath = ${PAPER}\n\turl = https://github.com/cordiverse/paper.git\n`);
  link(oldPaper);
  const base = commit('Baseline');
  function push(before = base, after = git(['rev-parse', 'HEAD']), extra = {}) {
    return classifyScope({ root, eventName: 'push', event: { before, after, forced: false, deleted: false, ...extra }, sha: after });
  }
  function merge(head, tree = git(['rev-parse', `${head}^{tree}`]), parents = [base, head]) {
    const sha = git(['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], 'Synthetic pull request merge\n');
    git(['checkout', '--quiet', '--detach', sha]);
    return sha;
  }
  function pull(head, sha, baseSha = base) {
    return classifyScope({ root, eventName: 'pull_request', event: { pull_request: { base: { sha: baseSha }, head: { sha: head } } }, sha });
  }
  return { root, git, oldPaper, newPaper, base, write, link, commit, push, merge, pull };
}

test('only a changed existing Paper gitlink uses light CI', () => {
  const f = fixture();
  f.link();
  const head = f.commit('Update Paper');
  assert.deepEqual(f.push(), { mode: 'paper', reason: 'only-paper-gitlink-changed', base: f.base, head, paths: [PAPER] });
  f.link(f.oldPaper);
  f.commit('Select an earlier Paper commit');
  assert.equal(f.push(head).mode, 'paper');
});

test('a multi-commit push includes code changed before its final Paper commit', () => {
  const f = fixture();
  f.write('scripts/program.mjs', 'console.log("new code");\n');
  const earlier = f.commit('Change code');
  f.link();
  f.commit('Update Paper');
  assert.equal(f.push(earlier).mode, 'paper');
  const entirePush = f.push();
  assert.equal(entirePush.mode, 'full');
  assert.deepEqual(entirePush.paths, [PAPER, 'scripts/program.mjs']);
});

test('mixed Paper and shared configuration, locks, code, or other submodules remain full', () => {
  for (const path of ['.gitmodules', '.github/workflows/ci.yml', 'package.json', 'pnpm-workspace.yaml',
    'dsh-source.lock.json', 'openharmony-source.lock.json', 'scripts/openharmony/source.py', 'unknown.txt']) {
    const f = fixture();
    f.link();
    f.write(path, 'changed\n');
    f.commit(`Change ${path} with Paper`);
    assert.equal(f.push().mode, 'full', path);
  }
  for (const path of ['.submodules/deepseek-harness', '.submodules/openharmony']) {
    const f = fixture();
    f.link();
    f.link(f.newPaper, path);
    f.commit('Change another upstream with Paper');
    assert.equal(f.push().mode, 'full', path);
  }
});

test('similar path names and paths inside a regular Paper directory are not Paper gitlink changes', () => {
  for (const path of ['.submodules/deepseek-harness-paper-extra', 'docs/deepseek-harness-paper.md']) {
    const f = fixture();
    f.link(f.newPaper, path);
    f.commit('Add another path');
    assert.equal(f.push().mode, 'full');
  }
  const f = fixture();
  f.git(['update-index', '--force-remove', PAPER]);
  f.commit('Remove gitlink');
  f.write(`${PAPER}/README.md`, 'ordinary content\n');
  f.commit('Add content instead of a submodule');
  assert.equal(f.push().mode, 'full');
});

test('Paper gitlink addition, deletion, and replacement with a regular file remain full', () => {
  const addition = fixture();
  addition.git(['update-index', '--force-remove', PAPER]);
  const absent = addition.commit('Remove Paper first');
  addition.link();
  addition.commit('Add Paper back');
  assert.equal(addition.push(absent).mode, 'full');
  const deletion = fixture();
  deletion.git(['update-index', '--force-remove', PAPER]);
  deletion.commit('Remove Paper');
  assert.equal(deletion.push().mode, 'full');
  const replacement = fixture();
  const blob = replacement.git(['hash-object', '-w', '--stdin'], 'ordinary file\n');
  replacement.git(['update-index', '--cacheinfo', `100644,${blob},${PAPER}`]);
  replacement.commit('Replace Paper gitlink');
  assert.equal(replacement.push().mode, 'full');
});

test('new branches, empty changes, unavailable objects, and malformed events remain full', () => {
  const f = fixture();
  assert.equal(f.push().mode, 'full');
  f.link();
  const head = f.commit('Update Paper');
  for (const before of [undefined, '', '0'.repeat(40), 'f'.repeat(40), `${f.base}\nmode=paper`]) {
    assert.equal(classifyScope({ root: f.root, eventName: 'push', event: { before, after: head }, sha: head }).mode, 'full');
  }
  for (const event of [undefined, null, 'push', {}, { before: f.base, after: 'invalid' }]) {
    assert.equal(classifyScope({ root: f.root, eventName: 'push', event, sha: head }).mode, 'full');
  }
  for (const sha of [undefined, '0'.repeat(40), f.base]) {
    assert.equal(classifyScope({ root: f.root, eventName: 'push', event: { before: f.base, after: head }, sha }).mode, 'full');
  }
});

test('manual, unsupported, forced, deleted, and divergent pushes cannot use light CI', () => {
  const f = fixture();
  f.link();
  const head = f.commit('Update Paper');
  for (const eventName of ['workflow_dispatch', 'pull_request_target', 'schedule', undefined]) {
    assert.equal(classifyScope({ root: f.root, eventName, event: { before: f.base, after: head }, sha: head }).mode, 'full');
  }
  for (const extra of [{ forced: true }, { deleted: true }, { forced: 'false' }, { deleted: 'false' }]) {
    assert.equal(f.push(f.base, head, extra).mode, 'full');
  }
  const divergent = f.git(['commit-tree', f.git(['rev-parse', `${head}^{tree}`]), '-p', f.base], 'Another descendant\n');
  f.git(['checkout', '--quiet', '--detach', divergent]);
  assert.equal(f.push(head, divergent).mode, 'full');
});

test('Git submodule ignore settings cannot conceal a non-Paper upstream change', () => {
  const f = fixture();
  f.link(f.oldPaper, '.submodules/deepseek-harness');
  const base = f.commit('Include DSH');
  f.link();
  f.link(f.newPaper, '.submodules/deepseek-harness');
  f.commit('Update both upstreams');
  f.git(['config', 'diff.ignoreSubmodules', 'all']);
  f.git(['config', 'submodule.deepseek-harness.ignore', 'all']);
  assert.equal(f.push(base).mode, 'full');
});

test('a standard pull request test merge containing only a Paper update uses light CI', () => {
  const f = fixture();
  f.link();
  const head = f.commit('Paper pull request');
  const merge = f.merge(head);
  assert.equal(f.pull(head, merge).mode, 'paper');
});

test('a pull request test merge containing code or another upstream remains full', () => {
  const f = fixture();
  f.write('scripts/program.mjs', 'console.log("changed");\n');
  f.link();
  const head = f.commit('Mixed pull request');
  const merge = f.merge(head);
  assert.equal(f.pull(head, merge).mode, 'full');
});

test('ambiguous PR checkout, parent mismatches, missing history, and invalid metadata remain full', () => {
  const f = fixture();
  f.link();
  const head = f.commit('Paper pull request');
  assert.equal(f.pull(head, head).mode, 'full');
  const reversed = f.merge(head, undefined, [head, f.base]);
  assert.equal(f.pull(head, reversed).mode, 'full');
  const merge = f.merge(head);
  assert.equal(f.pull(head, merge, 'f'.repeat(40)).mode, 'full');
  assert.equal(f.pull(f.base, merge).mode, 'full');
  assert.equal(f.pull(head, head).mode, 'full');
  assert.equal(classifyScope({ root: f.root, eventName: 'pull_request', event: { pull_request: {} }, sha: merge }).mode, 'full');
});

test('CLI writes a fixed mode output and ignores inherited Git repository overrides', () => {
  const f = fixture();
  f.link();
  const head = f.commit('Update Paper');
  const script = join(f.root, 'scripts/ci/scope.mjs');
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./scope.mjs', import.meta.url)), script);
  const eventFile = join(f.root, 'event.json');
  const output = join(f.root, 'github-output');
  const summary = join(f.root, 'github-summary');
  writeFileSync(eventFile, JSON.stringify({ before: f.base, after: head }));
  writeFileSync(output, 'existing=value\n');
  const env = { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventFile,
    GITHUB_SHA: head, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GIT_DIR: '/nonexistent/apex-git-dir',
    GIT_WORK_TREE: '/nonexistent/apex-work-tree', GIT_INDEX_FILE: '/nonexistent/apex-index' };
  const result = JSON.parse(execFileSync(process.execPath, [script], { env, encoding: 'utf8' }));
  assert.equal(result.mode, 'paper');
  assert.equal(readFileSync(output, 'utf8'), 'existing=value\nmode=paper\n');
  assert.match(readFileSync(summary, 'utf8'), /Paper validation selected.*selected checks must still succeed/u);
  writeFileSync(eventFile, 'not JSON\nmode=paper\n');
  const fallback = JSON.parse(execFileSync(process.execPath, [script], { env, encoding: 'utf8' }));
  assert.equal(fallback.mode, 'full');
  assert.equal(readFileSync(output, 'utf8'), 'existing=value\nmode=paper\nmode=full\n');
});
