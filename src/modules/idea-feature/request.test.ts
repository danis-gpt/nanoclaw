import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { parseIdeaFeatureRequest, resolveApproverForRequest } from './request.js';

function now(): string {
  return new Date().toISOString();
}

function validCreate(): Record<string, unknown> {
  return {
    action: 'idea_feature_request',
    payload: {
      operation: 'idea_create',
      sourceEventId: '-1000000000001:119:ag-product',
      request: {
        title: 'Automatic onboarding plan',
        record_type: 'Idea',
        problem: 'Managers assemble onboarding plans manually',
        target_user: 'Team manager',
        expected_outcome: 'A standard plan is prepared faster',
        product_area: 'Onboarding',
      },
    },
  };
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
  for (const id of ['telegram:requester', 'telegram:mikhail', 'telegram:danis', 'telegram:second']) {
    await createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
    await addMember({ user_id: id, agent_group_id: 'ag-product', added_by: null, added_at: now() });
  }
  await grantRole({
    user_id: 'telegram:mikhail',
    role: 'product_approver',
    agent_group_id: 'ag-product',
    granted_by: null,
    granted_at: now(),
  });
  await grantRole({
    user_id: 'telegram:danis',
    role: 'technical_approver',
    agent_group_id: 'ag-product',
    granted_by: null,
    granted_at: now(),
  });
});

afterEach(async () => closeDb());

describe('parseIdeaFeatureRequest', () => {
  it('accepts a bounded exact request envelope', () => {
    expect(parseIdeaFeatureRequest(validCreate())).toMatchObject({
      operation: 'idea_create',
      sourceEventId: '-1000000000001:119:ag-product',
      request: { title: 'Automatic onboarding plan' },
    });
  });

  it.each(['actor_user_id', 'approver_user_id', 'grant_id', 'project_id', 'outline_uuid'])(
    'rejects model-supplied host control %s at any depth',
    (field) => {
      const content = validCreate();
      const request = (content.payload as { request: Record<string, unknown> }).request;
      request.details = { [field]: 'attacker' };
      expect(() => parseIdeaFeatureRequest(content)).toThrow('host-controlled');
    },
  );

  it('rejects unknown operations and additional request fields', () => {
    const unknown = validCreate();
    (unknown.payload as Record<string, unknown>).operation = 'plane_create_task';
    expect(() => parseIdeaFeatureRequest(unknown)).toThrow('operation is not allowlisted');

    const extra = validCreate();
    (extra.payload as { request: Record<string, unknown> }).request.project = 'IDEA';
    expect(() => parseIdeaFeatureRequest(extra)).toThrow('additional field');
  });
});

describe('resolveApproverForRequest', () => {
  it('routes ordinary requests and conversion to the exact verified requester', async () => {
    await expect(resolveApproverForRequest('idea_create', 'telegram:requester', 'ag-product')).resolves.toEqual({
      approverUserId: 'telegram:requester',
      requiredRole: null,
    });
    await expect(
      resolveApproverForRequest('idea_convert_to_feature', 'telegram:requester', 'ag-product'),
    ).resolves.toEqual({ approverUserId: 'telegram:requester', requiredRole: null });
  });

  it('routes product only to Mikhail and technical only to Danis', async () => {
    await expect(
      resolveApproverForRequest('idea_record_product_decision', 'telegram:requester', 'ag-product'),
    ).resolves.toEqual({ approverUserId: 'telegram:mikhail', requiredRole: 'product_approver' });
    await expect(
      resolveApproverForRequest('idea_record_technical_decision', 'telegram:requester', 'ag-product'),
    ).resolves.toEqual({ approverUserId: 'telegram:danis', requiredRole: 'technical_approver' });
  });

  it('blocks zero or multiple active configured domain approvers', async () => {
    await grantRole({
      user_id: 'telegram:second',
      role: 'product_approver',
      agent_group_id: 'ag-product',
      granted_by: null,
      granted_at: now(),
    });
    await expect(
      resolveApproverForRequest('idea_record_product_decision', 'telegram:requester', 'ag-product'),
    ).rejects.toThrow('requires exactly one active product_approver');

    await expect(
      resolveApproverForRequest('idea_record_technical_decision', 'telegram:requester', 'ag-missing'),
    ).rejects.toThrow('requires exactly one active technical_approver');
  });
});
