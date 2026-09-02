#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const PRODUCT_GROUP = 'ag-5ebefc95-eaf4-43c3-baec-78e579544926';
const USER = 'tg:built-smoke-approver';
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const allowed = new Set(['--dist-root', '--recovery-root', '--fixture-root']);
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!allowed.has(flag) || !value || values.has(flag)) {
      throw new Error('usage: smoke-artha-17-built-host.mjs --dist-root ABS --recovery-root ABS --fixture-root ABS');
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) throw new Error('all smoke paths are required');
  for (const [flag, value] of values) {
    if (!path.isAbsolute(value) || fs.realpathSync(value) !== value)
      throw new Error(`${flag} must be physical absolute path`);
  }
  return {
    distRoot: values.get('--dist-root'),
    recoveryRoot: values.get('--recovery-root'),
    fixtureRoot: values.get('--fixture-root'),
  };
}

function createRoleDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE user_roles (
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    agent_group_id TEXT,
    granted_by TEXT,
    granted_at TEXT NOT NULL
  )`);
  db.close();
}

async function smoke({ distRoot, recoveryRoot, fixtureRoot }) {
  const dist = (relative) => pathToFileURL(path.join(distRoot, relative)).href;
  const normalDb = path.join(fixtureRoot, 'normal-v2.db');
  createRoleDb(normalDb);
  const connection = await import(dist('db/connection.js'));
  connection.initDb(normalDb);
  let cliServer;
  try {
    await import(dist('cli/commands/index.js'));
    cliServer = await import(dist('cli/socket-server.js'));
    const socketDir = path.join(fixtureRoot, 'data');
    fs.mkdirSync(socketDir, { mode: 0o700 });
    await cliServer.startCliServer(path.join(socketDir, 'ncl.sock'));
    const client = path.join(distRoot, 'cli', 'client.js');
    const help = await execFileAsync(process.execPath, [client, 'roles', 'help', 'grant'], { cwd: fixtureRoot });
    assert.match(help.stdout, /product_approver/);
    assert.match(help.stdout, /technical_approver/);
    await execFileAsync(
      process.execPath,
      [
        client,
        'roles',
        'grant',
        '--user',
        USER,
        '--role',
        'product_approver',
        '--group',
        PRODUCT_GROUP,
        '--granted-by',
        'smoke',
      ],
      { cwd: fixtureRoot },
    );
    assert.equal(connection.getDb().prepare('SELECT count(*) AS n FROM user_roles').get().n, 1);
    await execFileAsync(
      process.execPath,
      [client, 'roles', 'revoke', '--user', USER, '--role', 'product_approver', '--group', PRODUCT_GROUP],
      { cwd: fixtureRoot },
    );
    assert.equal(connection.getDb().prepare('SELECT count(*) AS n FROM user_roles').get().n, 0);
  } finally {
    await cliServer?.stopCliServer();
    connection.closeDb();
  }

  const offlineDir = path.join(fixtureRoot, 'offline-data');
  fs.mkdirSync(offlineDir, { mode: 0o700 });
  const offlineDb = path.join(offlineDir, 'v2.db');
  createRoleDb(offlineDb);
  const seed = new Database(offlineDb);
  seed
    .prepare('INSERT INTO user_roles VALUES (?, ?, ?, ?, ?)')
    .run(USER, 'technical_approver', PRODUCT_GROUP, 'smoke', '2026-09-02T00:00:00.000Z');
  seed.close();
  fs.chmodSync(offlineDb, 0o600);
  const stoppedMarker = path.join(fixtureRoot, 'nanoclaw.stopped');
  fs.writeFileSync(stoppedMarker, 'inactive\n', { mode: 0o600 });
  let serviceChecks = 0;
  const dependencies = {
    expectedDatabasePath: offlineDb,
    expectedUid: process.geteuid(),
    assertServiceStopped: async () => {
      serviceChecks += 1;
      assert.equal(fs.readFileSync(stoppedMarker, 'utf8'), 'inactive\n');
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
  await assert.rejects(recoveryModule.runOfflineRoleRecovery(['grant'], dependencies), /only supported verb is revoke/);
  await assert.rejects(
    recoveryModule.runOfflineRoleRecovery(
      exact.map((value) => (value === PRODUCT_GROUP ? 'ag-nonexact' : value)),
      dependencies,
    ),
    /exact Product group/,
  );
  const result = await recoveryModule.runOfflineRoleRecovery(exact, dependencies);
  assert.deepEqual(result, {
    revoked: { user_id: USER, role: 'technical_approver', agent_group_id: PRODUCT_GROUP },
  });
  assert.equal(serviceChecks, 1);
  const verify = new Database(offlineDb, { readonly: true });
  assert.deepEqual(verify.prepare('SELECT * FROM user_roles').all(), []);
  verify.close();

  process.stdout.write('ARTHA_17_BUILT_HOST_SMOKE_OK\n');
}

smoke(parseArgs(process.argv.slice(2))).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
