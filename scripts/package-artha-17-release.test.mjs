import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { packageArtha17Release } from './package-artha-17-release.mjs';

const roots = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artha-package-test-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'dist', 'z.js'), 'export const z = 1;\n');
  fs.writeFileSync(path.join(repo, 'dist', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(
    path.join(repo, 'src', 'cli', 'offline-role-recovery.ts'),
    "import Database from 'better-sqlite3'; export async function runOfflineRoleRecovery(argv: string[]) { if (argv[0] !== 'revoke') throw new Error('only revoke'); const db = new Database(':memory:'); db.close(); return {revoked:true}; }\n",
  );
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(repo, 'node_modules'), 'dir');
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: repo });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: repo });
  execFileSync('/usr/bin/git', ['add', '.'], { cwd: repo });
  execFileSync('/usr/bin/git', ['commit', '-qm', 'fixture'], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-09-02T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-09-02T00:00:00Z',
    },
  });
  const artifacts1 = path.join(root, 'artifacts-1');
  const artifacts2 = path.join(root, 'artifacts-2');
  fs.mkdirSync(artifacts1, { mode: 0o700 });
  fs.mkdirSync(artifacts2, { mode: 0o700 });
  return { root, repo, artifacts1, artifacts2 };
}

test.afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('packages deterministic sorted dist and standalone revoke-only bundle bound to commit/tree', async () => {
  const f = fixture();
  const first = packageArtha17Release({ repo: f.repo, artifactDir: f.artifacts1 });
  const second = packageArtha17Release({ repo: f.repo, artifactDir: f.artifacts2 });

  assert.match(first.sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(first.sourceTree, /^[0-9a-f]{40}$/);
  assert.equal(first.sourceCommit, second.sourceCommit);
  assert.equal(first.sourceTree, second.sourceTree);
  assert.equal(first.dist.sha256, second.dist.sha256);
  assert.equal(first.recovery.sha256, second.recovery.sha256);
  assert.equal(fs.readFileSync(first.dist.path).compare(fs.readFileSync(second.dist.path)), 0);
  assert.equal(fs.readFileSync(first.recovery.path).compare(fs.readFileSync(second.recovery.path)), 0);

  const distList = execFileSync('/usr/bin/tar', ['-tf', first.dist.path], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(distList, ['dist/', 'dist/a.js', 'dist/z.js']);
  const recoveryList = execFileSync('/usr/bin/tar', ['-tf', first.recovery.path], { encoding: 'utf8' });
  assert.match(recoveryList, /offline-role-recovery\.mjs/);
  assert.doesNotMatch(recoveryList, /dist\//);

  const extracted = path.join(f.root, 'extracted');
  fs.mkdirSync(extracted);
  execFileSync('/usr/bin/tar', ['-xf', first.recovery.path, '-C', extracted]);
  const built = fs.readFileSync(path.join(extracted, 'recovery', 'offline-role-recovery.mjs'), 'utf8');
  assert.doesNotMatch(built, /grantRole|roles[ -]grant|--grant/);
  const recovery = await import(
    `${pathToFileURL(path.join(extracted, 'recovery', 'offline-role-recovery.mjs')).href}?test=${Date.now()}`
  );
  await assert.doesNotReject(recovery.runOfflineRoleRecovery(['revoke']));
});

test('fails closed on dirty source, in-repo output, weak artifact mode, missing dist, and overwrite', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, 'dirty'), 'x');
  assert.throws(
    () => packageArtha17Release({ repo: f.repo, artifactDir: f.artifacts1, includeRuntimeDependencies: false }),
    /clean source commit/,
  );
  fs.unlinkSync(path.join(f.repo, 'dirty'));

  assert.throws(
    () =>
      packageArtha17Release({ repo: f.repo, artifactDir: path.join(f.repo, 'out'), includeRuntimeDependencies: false }),
    /outside repository/,
  );
  fs.chmodSync(f.artifacts1, 0o755);
  assert.throws(
    () => packageArtha17Release({ repo: f.repo, artifactDir: f.artifacts1, includeRuntimeDependencies: false }),
    /mode 0700/,
  );
  fs.chmodSync(f.artifacts1, 0o700);

  const missing = fixture();
  fs.rmSync(path.join(missing.repo, 'dist'), { recursive: true });
  execFileSync('/usr/bin/git', ['add', '-u'], { cwd: missing.repo });
  execFileSync('/usr/bin/git', ['commit', '-qm', 'remove dist'], { cwd: missing.repo });
  assert.throws(
    () =>
      packageArtha17Release({
        repo: missing.repo,
        artifactDir: missing.artifacts1,
        includeRuntimeDependencies: false,
      }),
    /dist directory/,
  );

  packageArtha17Release({ repo: f.repo, artifactDir: f.artifacts1, includeRuntimeDependencies: false });
  assert.throws(
    () => packageArtha17Release({ repo: f.repo, artifactDir: f.artifacts1, includeRuntimeDependencies: false }),
    /refusing to overwrite/,
  );
});
