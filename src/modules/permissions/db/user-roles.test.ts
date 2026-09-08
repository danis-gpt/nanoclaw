import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../../db/index.js';
import { createUser } from './users.js';
import { getScopedRoleHolders, grantRole, hasScopedRole } from './user-roles.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-product',
    name: 'Product',
    folder: 'product',
    agent_provider: null,
    created_at: now(),
  });
  await createAgentGroup({ id: 'ag-other', name: 'Other', folder: 'other', agent_provider: null, created_at: now() });
  for (const id of ['telegram:mikhail', 'telegram:danis', 'telegram:owner', 'telegram:admin']) {
    await createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
  }
});

afterEach(async () => closeDb());

describe('scoped Idea Feature roles', () => {
  it('matches the exact user, domain role, and agent group', async () => {
    await grantRole({
      user_id: 'telegram:mikhail',
      role: 'product_approver',
      agent_group_id: 'ag-product',
      granted_by: null,
      granted_at: now(),
    });

    await expect(hasScopedRole('telegram:mikhail', 'product_approver', 'ag-product')).resolves.toBe(true);
    await expect(hasScopedRole('telegram:mikhail', 'technical_approver', 'ag-product')).resolves.toBe(false);
    await expect(hasScopedRole('telegram:mikhail', 'product_approver', 'ag-other')).resolves.toBe(false);
    await expect(hasScopedRole('telegram:danis', 'product_approver', 'ag-product')).resolves.toBe(false);
  });

  it('does not treat owner or admin as a domain approver', async () => {
    await grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    await grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-product',
      granted_by: null,
      granted_at: now(),
    });

    await expect(hasScopedRole('telegram:owner', 'product_approver', 'ag-product')).resolves.toBe(false);
    await expect(hasScopedRole('telegram:admin', 'technical_approver', 'ag-product')).resolves.toBe(false);
  });

  it('requires domain roles to be scoped and lists holders deterministically', async () => {
    await expect(
      grantRole({
        user_id: 'telegram:mikhail',
        role: 'product_approver',
        agent_group_id: null,
        granted_by: null,
        granted_at: now(),
      }),
    ).rejects.toThrow('domain approver role must be scoped');

    await grantRole({
      user_id: 'telegram:mikhail',
      role: 'product_approver',
      agent_group_id: 'ag-product',
      granted_by: null,
      granted_at: '2026-01-02T00:00:00.000Z',
    });
    await grantRole({
      user_id: 'telegram:danis',
      role: 'product_approver',
      agent_group_id: 'ag-product',
      granted_by: null,
      granted_at: '2026-01-01T00:00:00.000Z',
    });

    expect((await getScopedRoleHolders('product_approver', 'ag-product')).map((row) => row.user_id)).toEqual([
      'telegram:danis',
      'telegram:mikhail',
    ]);
  });
});
