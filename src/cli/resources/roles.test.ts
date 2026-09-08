import { beforeEach, describe, expect, it, vi } from 'vitest';

const roleDb = vi.hoisted(() => ({
  grantRole: vi.fn(),
  revokeRole: vi.fn(),
  getUserRoles: vi.fn(),
}));

vi.mock('../../modules/permissions/db/user-roles.js', () => roleDb);

import { lookup } from '../registry.js';
import './roles.js';

const host = { caller: 'host' as const };
const PRODUCT_GROUP = 'ag-5ebefc95-eaf4-43c3-baec-78e579544926';

describe('roles grant/revoke CLI', () => {
  const grant = lookup('roles-grant')!;
  const revoke = lookup('roles-revoke')!;

  beforeEach(() => {
    vi.clearAllMocks();
    roleDb.getUserRoles.mockReturnValue([]);
  });

  const row = (role: string, agent_group_id: string | null) => ({
    user_id: 'tg:1',
    role,
    agent_group_id,
    granted_by: 'operator',
    granted_at: '2026-09-02T00:00:00.000Z',
  });

  it('keeps both mutations approval-gated and declares every role in help metadata', () => {
    expect(grant.access).toBe('approval');
    expect(revoke.access).toBe('approval');
    for (const role of ['owner', 'admin', 'product_approver', 'technical_approver']) {
      expect(() => grant.parseArgs({ user: 'tg:1', role })).not.toThrow();
      expect(() => revoke.parseArgs({ user: 'tg:1', role })).not.toThrow();
    }
  });

  it.each([
    ['owner', undefined, null],
    ['admin', undefined, null],
    ['admin', PRODUCT_GROUP, PRODUCT_GROUP],
    ['product_approver', PRODUCT_GROUP, PRODUCT_GROUP],
    ['technical_approver', PRODUCT_GROUP, PRODUCT_GROUP],
  ])('grants valid role/scope %s / %s only through grantRole', async (role, group, expectedGroup) => {
    const raw = { user: 'tg:1', role, ...(group ? { group } : {}), granted_by: 'operator' };
    const result = await grant.handler(grant.parseArgs(raw), host);
    expect(roleDb.grantRole).toHaveBeenCalledOnce();
    expect(roleDb.grantRole).toHaveBeenCalledWith({
      user_id: 'tg:1',
      role,
      agent_group_id: expectedGroup,
      granted_by: 'operator',
      granted_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(result).toEqual({ user_id: 'tg:1', role, agent_group_id: expectedGroup });
  });

  it.each([
    ['owner', undefined, null],
    ['admin', undefined, null],
    ['admin', PRODUCT_GROUP, PRODUCT_GROUP],
  ])('keeps an existing %s / %s grant idempotently without inserting a duplicate', async (role, group, scope) => {
    roleDb.getUserRoles.mockReturnValue([row(role, scope), row('technical_approver', PRODUCT_GROUP)]);
    const raw = { user: 'tg:1', role, ...(group ? { group } : {}) };
    await expect(grant.handler(grant.parseArgs(raw), host)).resolves.toEqual({
      user_id: 'tg:1',
      role,
      agent_group_id: scope,
    });
    expect(roleDb.grantRole).not.toHaveBeenCalled();
  });

  it.each([
    ['owner', PRODUCT_GROUP],
    ['product_approver', undefined],
    ['technical_approver', undefined],
  ])('rejects invalid grant scope %s / %s before the helper', async (role, group) => {
    const args = grant.parseArgs({ user: 'tg:1', role, ...(group ? { group } : {}) });
    await expect(grant.handler(args, host)).rejects.toThrow(/scope|group|global/);
    expect(roleDb.grantRole).not.toHaveBeenCalled();
  });

  it.each([
    ['owner', undefined, null],
    ['admin', undefined, null],
    ['admin', PRODUCT_GROUP, PRODUCT_GROUP],
    ['product_approver', PRODUCT_GROUP, PRODUCT_GROUP],
    ['technical_approver', PRODUCT_GROUP, PRODUCT_GROUP],
  ])('revokes valid role/scope %s / %s only through revokeRole', async (role, group, expectedGroup) => {
    const unrelated = role === 'owner' ? row('technical_approver', PRODUCT_GROUP) : row('owner', null);
    roleDb.getUserRoles.mockReturnValueOnce([row(role, expectedGroup), unrelated]).mockReturnValueOnce([unrelated]);
    const raw = { user: 'tg:1', role, ...(group ? { group } : {}) };
    const result = await revoke.handler(revoke.parseArgs(raw), host);
    expect(roleDb.revokeRole).toHaveBeenCalledOnce();
    expect(roleDb.revokeRole).toHaveBeenCalledWith('tg:1', role, expectedGroup);
    expect(result).toEqual({ revoked: { user_id: 'tg:1', role, agent_group_id: expectedGroup } });
  });

  it.each([
    ['owner', undefined, [row('owner', PRODUCT_GROUP)]],
    ['admin', undefined, [row('admin', PRODUCT_GROUP)]],
    ['admin', PRODUCT_GROUP, [row('admin', null)]],
    ['product_approver', PRODUCT_GROUP, [row('technical_approver', PRODUCT_GROUP)]],
  ])('rejects missing exact revoke %s / %s and preserves unrelated grants', async (role, group, existing) => {
    roleDb.getUserRoles.mockReturnValue(existing);
    const raw = { user: 'tg:1', role, ...(group ? { group } : {}) };
    await expect(revoke.handler(revoke.parseArgs(raw), host)).rejects.toThrow('exact role grant does not exist');
    expect(roleDb.revokeRole).not.toHaveBeenCalled();
  });

  it.each([
    ['owner', PRODUCT_GROUP],
    ['product_approver', undefined],
    ['technical_approver', undefined],
  ])('rejects invalid revoke scope %s / %s before the helper', async (role, group) => {
    const args = revoke.parseArgs({ user: 'tg:1', role, ...(group ? { group } : {}) });
    await expect(revoke.handler(args, host)).rejects.toThrow(/scope|group|global/);
    expect(roleDb.revokeRole).not.toHaveBeenCalled();
  });

  it.each([grant, revoke])('strictly rejects missing, unknown-role, and unknown flags', (command) => {
    expect(() => command.parseArgs({ role: 'admin' })).toThrow('--user is required');
    expect(() => command.parseArgs({ user: 'tg:1', role: 'superuser' })).toThrow(
      '--role must be one of: owner, admin, product_approver, technical_approver',
    );
    expect(() => command.parseArgs({ user: 'tg:1', role: 'admin', sql: 'DELETE' })).toThrow('unknown flag --sql');
  });
});
