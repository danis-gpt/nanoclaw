#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const PRODUCT_GROUP = 'ag-5ebefc95-eaf4-43c3-baec-78e579544926';
const USER = 'tg:built-smoke-approver';
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  if (argv[0] !== '--fixture-only' || argv.length !== 5)
    throw new Error(
      'usage: smoke-artha-17-built-host.mjs --fixture-only --dist-bundle ABS --offline-recovery-bundle ABS',
    );
  const values = new Map();
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!['--dist-bundle', '--offline-recovery-bundle'].includes(flag) || !value || values.has(flag))
      throw new Error('invalid or duplicate smoke bundle flag');
    values.set(flag, value);
  }
  if (values.size !== 2) throw new Error('both smoke bundles are required');
  return { distBundle: values.get('--dist-bundle'), recoveryBundle: values.get('--offline-recovery-bundle') };
}

function tarString(block, start, length) {
  const end = block.indexOf(0, start);
  return block.subarray(start, end >= start && end < start + length ? end : start + length).toString('utf8');
}

function tarOctal(block, start, length) {
  const value = tarString(block, start, length).trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error('invalid tar numeric field');
  return Number.parseInt(value, 8);
}

function safeArchivePath(name) {
  if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0'))
    throw new Error('unsafe archive path');
  const stripped = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!stripped || stripped.split('/').some((part) => part === '' || part === '.' || part === '..'))
    throw new Error('unsafe archive path');
  if (path.posix.normalize(stripped) !== stripped) throw new Error('unsafe archive path');
  return stripped;
}

export function extractSafeTar(bundle, destination) {
  const bundleStat = fs.lstatSync(bundle);
  if (!bundleStat.isFile() || bundleStat.isSymbolicLink() || bundleStat.nlink !== 1)
    throw new Error('bundle must be a single-link physical regular file');
  const bytes = fs.readFileSync(bundle);
  const seen = new Set();
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const block = bytes.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const storedChecksum = tarOctal(block, 148, 8);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 0x20 : block[i];
    if (checksum !== storedChecksum) throw new Error('invalid tar checksum');
    const prefix = tarString(block, 345, 155);
    const leaf = tarString(block, 0, 100);
    const relative = safeArchivePath(prefix ? `${prefix}/${leaf}` : leaf);
    if (seen.has(relative)) throw new Error(`duplicate archive entry: ${relative}`);
    seen.add(relative);
    const type = String.fromCharCode(block[156] || 0x30);
    if (type !== '0' && type !== '5') throw new Error(`unsafe archive entry type for ${relative}`);
    const size = tarOctal(block, 124, 12);
    if (type === '5' && size !== 0) throw new Error('archive directory has content bytes');
    const target = path.join(destination, ...relative.split('/'));
    if (type === '5') fs.mkdirSync(target, { recursive: false, mode: 0o700 });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(
        target,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeSync(fd, bytes, offset + 512, size);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const archivedMode = tarOctal(block, 100, 8);
      fs.chmodSync(target, archivedMode & 0o111 ? 0o700 : 0o600);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyArtifactManifest(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'artifact-manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.match(manifest.source_commit, /^[0-9a-f]{40}$/u);
  assert.match(manifest.source_tree, /^[0-9a-f]{40}$/u);
  const actual = [];
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative === 'artifact-manifest.json') continue;
      const stat = fs.lstatSync(path.join(directory, name));
      if (stat.isDirectory()) visit(path.join(directory, name), relative);
      else {
        assert.equal(stat.isFile() && stat.nlink === 1, true, `unsafe extracted artifact ${relative}`);
        actual.push(relative);
      }
    }
  };
  visit(root);
  assert.deepEqual(actual, Object.keys(manifest.files).sort(), 'artifact manifest must name the exact file set');
  for (const [relative, expected] of Object.entries(manifest.files)) {
    assert.equal(safeArchivePath(relative), relative);
    assert.match(expected, /^[0-9a-f]{64}$/u);
    assert.equal(sha256(path.join(root, ...relative.split('/'))), expected);
  }
  return manifest;
}

function safeFixtureRoot() {
  const home = fs.realpathSync(os.homedir());
  const homeStat = fs.lstatSync(home);
  if (!homeStat.isDirectory() || homeStat.uid !== process.geteuid() || (homeStat.mode & 0o022) !== 0)
    throw new Error('home must be an euid-owned directory not writable by group/other');
  const base = path.join(home, '.nanoclaw-built-smoke-fixtures');
  fs.mkdirSync(base, { mode: 0o700 });
  fs.chmodSync(base, 0o700);
  return fs.mkdtempSync(path.join(base, 'artha-17-'));
}

function createRoleDb(Database, dbPath) {
  const db = new Database(dbPath);
  db.exec(
    'CREATE TABLE user_roles (user_id TEXT NOT NULL, role TEXT NOT NULL, agent_group_id TEXT, granted_by TEXT, granted_at TEXT NOT NULL)',
  );
  db.close();
}

async function smoke({ distBundle, recoveryBundle }) {
  const fixtureRoot = safeFixtureRoot();
  try {
    extractSafeTar(path.resolve(distBundle), fixtureRoot);
    extractSafeTar(path.resolve(recoveryBundle), fixtureRoot);
    const distRoot = path.join(fixtureRoot, 'release');
    const recoveryRoot = path.join(fixtureRoot, 'recovery');
    const distManifest = verifyArtifactManifest(distRoot);
    const recoveryManifest = verifyArtifactManifest(recoveryRoot);
    assert.equal(recoveryManifest.source_commit, distManifest.source_commit);
    assert.equal(recoveryManifest.source_tree, distManifest.source_tree);
    const Database = createRequire(path.join(distRoot, 'package.json'))('better-sqlite3');
    const dist = (relative) => pathToFileURL(path.join(distRoot, 'dist', relative)).href;
    const normalDb = path.join(fixtureRoot, 'normal-v2.db');
    createRoleDb(Database, normalDb);
    const normalSeed = new Database(normalDb);
    normalSeed
      .prepare('INSERT INTO user_roles VALUES (?, ?, ?, ?, ?)')
      .run(USER, 'technical_approver', PRODUCT_GROUP, 'smoke', '2026-09-02T00:00:00.000Z');
    normalSeed.close();
    const connection = await import(dist('db/connection.js'));
    connection.initDb(normalDb);
    let cliServer;
    const socketPath = path.join(fixtureRoot, 'data', 'ncl.sock');
    try {
      await import(dist('cli/commands/index.js'));
      cliServer = await import(dist('cli/socket-server.js'));
      fs.mkdirSync(path.dirname(socketPath), { mode: 0o700 });
      await cliServer.startCliServer(socketPath);
      const socketStat = fs.lstatSync(socketPath);
      assert.equal(socketStat.uid, process.geteuid());
      assert.equal(socketStat.mode & 0o777, 0o600);
      const client = path.join(distRoot, 'dist', 'cli', 'client.js');
      const invoke = (args) => execFileAsync(process.execPath, [client, ...args], { cwd: fixtureRoot });
      assert.match((await invoke(['roles', 'help', 'grant'])).stdout, /product_approver/u);
      const grant = ['roles', 'grant', '--user', USER, '--role', 'product_approver', '--group', PRODUCT_GROUP];
      await invoke([...grant, '--granted-by', 'smoke']);
      await invoke([...grant, '--granted-by', 'repeat']);
      assert.equal(connection.getDb().prepare('SELECT count(*) AS n FROM user_roles').get().n, 2);
      await assert.rejects(invoke(['roles', 'revoke', '--user', USER, '--role', 'owner']), /Command failed/u);
      await invoke(['roles', 'revoke', '--user', USER, '--role', 'product_approver', '--group', PRODUCT_GROUP]);
      assert.deepEqual(connection.getDb().prepare('SELECT role FROM user_roles ORDER BY role').all(), [
        { role: 'technical_approver' },
      ]);
    } finally {
      await cliServer?.stopCliServer();
      connection.closeDb();
    }
    assert.equal(fs.existsSync(socketPath), false, 'Unix socket must be removed after server stop');

    const offlineDir = path.join(fixtureRoot, 'offline-data');
    fs.mkdirSync(offlineDir, { mode: 0o700 });
    const offlineDb = path.join(offlineDir, 'v2.db');
    createRoleDb(Database, offlineDb);
    const seed = new Database(offlineDb);
    const insert = seed.prepare('INSERT INTO user_roles VALUES (?, ?, ?, ?, ?)');
    insert.run(USER, 'technical_approver', PRODUCT_GROUP, 'smoke', '2026-09-02T00:00:00.000Z');
    insert.run(USER, 'owner', null, 'smoke', '2026-09-02T00:00:00.000Z');
    seed.close();
    fs.chmodSync(offlineDb, 0o600);
    let serviceChecks = 0;
    const dependencies = {
      expectedDatabasePath: offlineDb,
      expectedUid: process.geteuid(),
      assertServiceStopped: async () => {
        serviceChecks += 1;
      },
    };
    const recoveryModule = await import(pathToFileURL(path.join(recoveryRoot, 'offline-role-recovery.mjs')).href);
    const exact = [
      'revoke',
      '--database',
      offlineDb,
      '--expected-user-id',
      USER,
      '--target-user-id',
      USER,
      '--role',
      'technical_approver',
      '--group',
      PRODUCT_GROUP,
    ];
    await assert.rejects(
      recoveryModule.runOfflineRoleRecovery(['grant'], dependencies),
      /only supported verb is revoke/u,
    );
    await assert.rejects(
      recoveryModule.runOfflineRoleRecovery(
        exact.map((v) => (v === PRODUCT_GROUP ? 'ag-nonexact' : v)),
        dependencies,
      ),
      /exact Product group/u,
    );
    await recoveryModule.runOfflineRoleRecovery(exact, dependencies);
    assert.equal(serviceChecks, 3);
    const verify = new Database(offlineDb, { readonly: true });
    assert.deepEqual(verify.prepare('SELECT role FROM user_roles ORDER BY role').all(), [{ role: 'owner' }]);
    verify.close();
    process.stdout.write('ARTHA_17_BUILT_HOST_SMOKE_OK\n');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  smoke(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
