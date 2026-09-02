import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDb } from '../db/connection.js';
import {
  PRODUCT_AGENT_GROUP_ID,
  runOfflineRoleRecovery,
  type OfflineRoleRecoveryDependencies,
} from './offline-role-recovery.js';

const roots: string[] = [];
const USER = 'tg:approved-human';

function fixture(grants = [{ role: 'product_approver', group: PRODUCT_AGENT_GROUP_ID }]) {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.artha-role-recovery-test-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const dbPath = path.join(data, 'v2.db');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE user_roles (
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    agent_group_id TEXT,
    granted_by TEXT,
    granted_at TEXT NOT NULL
  )`);
  const insert = db.prepare(
    'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const grant of grants) insert.run(USER, grant.role, grant.group, 'operator', '2026-09-02T00:00:00.000Z');
  db.close();
  fs.chmodSync(dbPath, 0o600);
  const assertServiceStopped = vi.fn(async () => undefined);
  const deps: OfflineRoleRecoveryDependencies = {
    expectedDatabasePath: dbPath,
    expectedUid: process.geteuid!(),
    assertServiceStopped,
  };
  return { root, dbPath, deps, assertServiceStopped };
}

function args(dbPath: string, overrides: Record<string, string> = {}): string[] {
  const values = {
    database: dbPath,
    'expected-user-id': USER,
    'target-user-id': USER,
    role: 'product_approver',
    group: PRODUCT_AGENT_GROUP_ID,
    ...overrides,
  };
  return ['revoke', ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value])];
}

afterEach(() => {
  closeDb();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('offline role recovery', () => {
  it('revokes the one exact Product domain grant and proves read-back', async () => {
    const f = fixture();
    await expect(runOfflineRoleRecovery(args(f.dbPath), f.deps)).resolves.toEqual({
      revoked: { user_id: USER, role: 'product_approver', agent_group_id: PRODUCT_AGENT_GROUP_ID },
    });
    expect(f.assertServiceStopped).toHaveBeenCalledOnce();
    const db = new Database(f.dbPath, { readonly: true });
    expect(db.prepare('SELECT * FROM user_roles').all()).toEqual([]);
    db.close();
  });

  it.each(['product_approver', 'technical_approver'])('permits only exact scoped %s recovery', async (role) => {
    const f = fixture([{ role, group: PRODUCT_AGENT_GROUP_ID }]);
    await expect(runOfflineRoleRecovery(args(f.dbPath, { role }), f.deps)).resolves.toBeDefined();
  });

  it.each([
    [['grant'], /only supported verb is revoke/],
    [['--grant', 'true'], /only supported verb is revoke/],
    [[], /only supported verb is revoke/],
  ])('rejects every grant-like/missing verb form', async (argv, error) => {
    const f = fixture();
    await expect(runOfflineRoleRecovery(argv, f.deps)).rejects.toThrow(error);
  });

  it.each([
    [{ role: 'owner' }, /role/],
    [{ role: 'admin' }, /role/],
    [{ role: 'product_approver', group: 'ag-other' }, /group/],
    [{ 'target-user-id': 'tg:other' }, /expected-user-id.*target-user-id/],
    [{ sql: 'DELETE FROM user_roles' }, /unknown flag --sql/],
    [{ grant: 'true' }, /unknown flag --grant/],
  ])('rejects non-exact or dangerous arguments %#', async (overrides, error) => {
    const f = fixture();
    await expect(runOfflineRoleRecovery(args(f.dbPath, overrides), f.deps)).rejects.toThrow(error);
    expect(f.assertServiceStopped).not.toHaveBeenCalled();
  });

  it('rejects a running service before opening the database', async () => {
    const f = fixture();
    f.deps.assertServiceStopped = vi.fn(async () => {
      throw new Error('NanoClaw service is active');
    });
    await expect(runOfflineRoleRecovery(args(f.dbPath), f.deps)).rejects.toThrow('service is active');
    const db = new Database(f.dbPath, { readonly: true });
    expect(db.prepare('SELECT count(*) AS n FROM user_roles').get()).toEqual({ n: 1 });
    db.close();
  });

  it('rejects ambiguity instead of choosing one of several grants', async () => {
    const f = fixture([
      { role: 'product_approver', group: PRODUCT_AGENT_GROUP_ID },
      { role: 'technical_approver', group: PRODUCT_AGENT_GROUP_ID },
    ]);
    await expect(runOfflineRoleRecovery(args(f.dbPath), f.deps)).rejects.toThrow('exactly one existing grant');
  });

  it('rejects absent exact grant and requires canonical read-back', async () => {
    const f = fixture([]);
    await expect(runOfflineRoleRecovery(args(f.dbPath), f.deps)).rejects.toThrow('exactly one existing grant');
  });

  it('rejects path, owner, mode, type, hardlink, and symlink drift', async () => {
    const f = fixture();
    await expect(
      runOfflineRoleRecovery(args(f.dbPath), { ...f.deps, expectedDatabasePath: `${f.dbPath}.other` }),
    ).rejects.toThrow('exact approved database path');

    fs.chmodSync(f.dbPath, 0o640);
    await expect(runOfflineRoleRecovery(args(f.dbPath), f.deps)).rejects.toThrow('mode 0600');
    fs.chmodSync(f.dbPath, 0o600);

    const hardlink = path.join(f.root, 'hardlink.db');
    fs.linkSync(f.dbPath, hardlink);
    await expect(runOfflineRoleRecovery(args(f.dbPath), f.deps)).rejects.toThrow('single-link');
    fs.unlinkSync(hardlink);

    const real = path.join(f.root, 'real.db');
    fs.renameSync(f.dbPath, real);
    fs.symlinkSync(real, f.dbPath);
    await expect(runOfflineRoleRecovery(args(f.dbPath), f.deps)).rejects.toThrow(/symlink|regular/);
  });

  it('rejects a symlinked or writable ancestor and an owner mismatch', async () => {
    const f = fixture();
    const data = path.dirname(f.dbPath);
    fs.chmodSync(data, 0o777);
    await expect(runOfflineRoleRecovery(args(f.dbPath), f.deps)).rejects.toThrow('writable ancestor');
    fs.chmodSync(data, 0o700);

    await expect(
      runOfflineRoleRecovery(args(f.dbPath), { ...f.deps, expectedUid: process.geteuid!() + 1 }),
    ).rejects.toThrow('owner');

    const realData = path.join(f.root, 'real-data');
    fs.renameSync(data, realData);
    fs.symlinkSync(realData, data);
    await expect(runOfflineRoleRecovery(args(f.dbPath), f.deps)).rejects.toThrow('symlink');
  });

  it('rejects a non-regular database object before opening SQLite', async () => {
    const f = fixture();
    fs.unlinkSync(f.dbPath);
    fs.mkdirSync(f.dbPath, { mode: 0o700 });
    await expect(runOfflineRoleRecovery(args(f.dbPath), f.deps)).rejects.toThrow('regular file');
  });
});
