#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAPER = '.submodules/deepseek-harness-paper';
const OBJECT_ID = /^[0-9a-f]{40}$/u;
const ZERO = '0'.repeat(40);

function objectId(value) {
  return typeof value === 'string' && OBJECT_ID.test(value) && value !== ZERO;
}

function git(root, ...args) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...environment, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function gitlink(root, revision) {
  const entries = git(root, 'ls-tree', '-z', revision, '--', PAPER).split('\0').filter(Boolean);
  if (entries.length !== 1) return undefined;
  const [metadata, path] = entries[0].split('\t');
  const [mode, type, commit] = metadata.split(' ');
  return path === PAPER && mode === '160000' && type === 'commit' && objectId(commit) ? commit : undefined;
}

/** Select the light path only when the checked-out commit proves a pure Paper gitlink update. */
export function classifyScope({ root, eventName, event, sha } = {}) {
  const full = (reason, details = {}) => ({ mode: 'full', reason, ...details });
  if (!['push', 'pull_request'].includes(eventName)) return full('event-requires-full-validation');
  if (!event || typeof event !== 'object' || !objectId(sha)) return full('event-or-sha-is-invalid');
  try {
    if (typeof root !== 'string' || root === '') return full('repository-is-unavailable');
    if (realpathSync(git(root, 'rev-parse', '--show-toplevel').trim()) !== realpathSync(root)) {
      return full('repository-root-does-not-match');
    }
    if (git(root, 'rev-parse', '--verify', 'HEAD').trim() !== sha) return full('checkout-does-not-match-event-sha');
    let base;
    const head = sha;
    if (eventName === 'push') {
      if (event.forced === true || event.deleted === true
        || (event.forced !== undefined && typeof event.forced !== 'boolean')
        || (event.deleted !== undefined && typeof event.deleted !== 'boolean')) {
        return full('forced-or-deleted-push');
      }
      if (!objectId(event.before) || !objectId(event.after) || event.after !== head) {
        return full('push-range-is-unavailable');
      }
      base = event.before;
      if (git(root, 'cat-file', '-t', base).trim() !== 'commit'
        || git(root, 'cat-file', '-t', head).trim() !== 'commit'
        || git(root, 'merge-base', base, head).trim() !== base) {
        return full('push-base-is-not-an-ancestor');
      }
    } else {
      const pull = event.pull_request;
      if (!objectId(pull?.base?.sha) || !objectId(pull?.head?.sha)) return full('pull-request-range-is-unavailable');
      base = pull.base.sha;
      if (git(root, 'cat-file', '-t', base).trim() !== 'commit'
        || git(root, 'cat-file', '-t', pull.head.sha).trim() !== 'commit') {
        return full('pull-request-commits-are-unavailable');
      }
      // actions/checkout uses GitHub's test merge by default. Other checkout modes remain full.
      const parents = git(root, 'show', '-s', '--format=%P', head).trim().split(' ');
      if (parents.length !== 2 || parents[0] !== base || parents[1] !== pull.head.sha) {
        return full('checkout-is-not-the-pull-request-test-merge');
      }
    }
    // Compare the entire push or actual PR merge, and override Git's submodule-ignore settings.
    const paths = git(root, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--ignore-submodules=none', '--name-only', '-z', base, head, '--').split('\0').filter(Boolean);
    const details = { base, head, paths };
    if (paths.length !== 1 || paths[0] !== PAPER) return full('changes-are-not-paper-only', details);
    const before = gitlink(root, base);
    const after = gitlink(root, head);
    if (!before || !after || before === after) return full('paper-is-not-an-existing-gitlink-update', details);
    return { mode: 'paper', reason: 'only-paper-gitlink-changed', ...details };
  } catch {
    // Incomplete fetches, malformed Git data, and unknown history must never suppress full CI.
    return full('history-could-not-be-verified');
  }
}

function isMainModule() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMainModule()) {
  let event;
  try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); } catch { /* Full fallback. */ }
  const result = classifyScope({
    root: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    eventName: process.env.GITHUB_EVENT_NAME,
    event,
    sha: process.env.GITHUB_SHA,
  });
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const selection = result.mode === 'paper' ? 'Paper validation' : 'Full validation';
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Validation scope\n\n${selection} selected (${result.reason}). This step only selects the scope; the selected checks must still succeed.\n`);
  }
}
