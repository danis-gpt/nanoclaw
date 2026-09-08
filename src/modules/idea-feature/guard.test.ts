import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingApproval, deletePendingApproval } from '../../db/sessions.js';
import { guard } from '../../guard/index.js';
import type { PendingApproval } from '../../types.js';
import { canonicalJson, ideaFeatureMutation } from './guard.js';

function approval(payload: Record<string, unknown>): PendingApproval {
  return {
    approval_id: 'appr-idea-feature-1',
    session_id: null,
    request_id: 'appr-idea-feature-1',
    action: 'idea_feature_request',
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    agent_group_id: null,
    channel_type: null,
    platform_id: null,
    instance: null,
    platform_message_id: null,
    expires_at: '2999-01-01T00:00:00.000Z',
    status: 'pending',
    title: 'Idea Feature request',
    question: '',
    options_json: '[]',
    approver_user_id: null,
  };
}

beforeEach(async () => runMigrations(await initTestDb()));

afterEach(async () => closeDb());

describe('ideaFeatureMutation', () => {
  it('holds a fresh mutation and accepts only a live, payload-bound grant', async () => {
    const payload = { action: 'idea_feature_request', payload: { request: { b: 2, a: 1 } } };
    const row = approval({ payload: { request: { a: 1, b: 2 } }, action: 'idea_feature_request' });
    await createPendingApproval(row);

    expect(
      (
        await guard(ideaFeatureMutation, {
          actor: { kind: 'agent', agentGroupId: 'ag-product' },
          payload,
          grant: null,
        })
      ).effect,
    ).toBe('hold');
    expect(
      (
        await guard(ideaFeatureMutation, {
          actor: { kind: 'agent', agentGroupId: 'ag-product' },
          payload,
          grant: row,
        })
      ).effect,
    ).toBe('allow');

    await deletePendingApproval(row.approval_id);
    expect(
      (
        await guard(ideaFeatureMutation, {
          actor: { kind: 'agent', agentGroupId: 'ag-product' },
          payload,
          grant: row,
        })
      ).effect,
    ).toBe('deny');
  });

  it('denies a grant for any changed nested value', async () => {
    const held = { action: 'idea_feature_request', payload: { request: { title: 'One' } } };
    const row = approval(held);
    await createPendingApproval(row);
    const changed = { action: 'idea_feature_request', payload: { request: { title: 'Two' } } };

    expect(
      (
        await guard(ideaFeatureMutation, {
          actor: { kind: 'agent', agentGroupId: 'ag-product' },
          payload: changed,
          grant: row,
        })
      ).effect,
    ).toBe('deny');
  });

  it('denies an expired Idea Feature grant', async () => {
    const payload = { action: 'idea_feature_request', payload: { request: { title: 'One' } } };
    const row = { ...approval(payload), expires_at: '2000-01-01T00:00:00.000Z' };
    await createPendingApproval(row);
    expect(
      (
        await guard(ideaFeatureMutation, {
          actor: { kind: 'agent', agentGroupId: 'ag-product' },
          payload,
          grant: row,
        })
      ).effect,
    ).toBe('deny');
  });

  it('canonicalises object key order while preserving array order', () => {
    expect(canonicalJson({ z: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"z":1}');
    expect(canonicalJson({ values: [2, 1] })).not.toBe(canonicalJson({ values: [1, 2] }));
  });
});
