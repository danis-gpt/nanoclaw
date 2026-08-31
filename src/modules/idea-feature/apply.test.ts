import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createUser } from '../permissions/db/users.js';
import type { PendingApproval, Session } from '../../types.js';
import { applyIdeaFeatureMutation, operationKeyFor } from './apply.js';
import { PendingVerificationError, type PrivateActionRequest } from './private-client.js';

const session: Session = {
  id: 'sess-product',
  agent_group_id: 'ag-product',
  messaging_group_id: 'mg-product',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

function grant(): PendingApproval {
  return {
    approval_id: 'appr-1',
    session_id: session.id,
    request_id: 'appr-1',
    action: 'idea_feature_request',
    payload: '{}',
    created_at: '2026-01-02T03:04:05.000Z',
    agent_group_id: session.agent_group_id,
    channel_type: 'telegram',
    platform_id: 'telegram:119',
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: 'Decision',
    question: '',
    options_json: '[]',
    approver_user_id: 'telegram:mikhail',
  };
}

function decisionContent(): Record<string, unknown> {
  return {
    action: 'idea_feature_request',
    payload: {
      operation: 'idea_record_product_decision',
      sourceEventId: '-1000000000001:119:ag-product',
      request: {
        task_id: 'IDEA-1',
        decision_id: 'product-1',
        outcome: 'approved',
        comment: 'Approved for technical review',
      },
    },
    _host: {
      verifiedActorUserId: 'telegram:requester',
      approverUserId: 'telegram:mikhail',
      requiredRole: 'product_approver',
    },
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createUser({
    id: 'telegram:mikhail',
    kind: 'telegram',
    display_name: 'Mikhail',
    created_at: '2026-01-01T00:00:00.000Z',
  });
});

afterEach(() => closeDb());

describe('applyIdeaFeatureMutation', () => {
  it('sends the consumed approval, exclusive human actor, source event, and canonical decision payload', async () => {
    let call: PrivateActionRequest | undefined;
    const notices: string[] = [];
    await applyIdeaFeatureMutation(decisionContent(), session, grant(), {
      callConnector: async (request) => {
        call = request;
        return { idea_id: 'IDEA-1', state: 'Product Approved' };
      },
      notify: (_session, text) => notices.push(text),
      operationContext: () => ({ instance: 'telegram', platformId: 'telegram:-1000000000001' }),
      now: () => '2026-01-02T03:04:05.000Z',
    });

    expect(call).toMatchObject({
      name: 'idea_record_product_decision',
      grantId: 'appr-1',
      actorUserId: 'telegram:mikhail',
      sourceEventId: '-1000000000001:119:ag-product',
      payload: {
        task_id: 'IDEA-1',
        decision: {
          schema_version: 1,
          decision_id: 'product-1',
          kind: 'product',
          actor_user_id: 'telegram:mikhail',
          actor_display_name: 'Mikhail',
          decided_at: '2026-01-02T03:04:05.000Z',
          source_event_id: '-1000000000001:119:ag-product',
        },
      },
    });
    expect(call?.operationKey).toMatch(/^[a-f0-9]{64}$/);
    expect(notices.at(-1)).toContain('IDEA-1');
  });

  it('reports timeout after write only as pending verification', async () => {
    const notices: string[] = [];
    await applyIdeaFeatureMutation(decisionContent(), session, grant(), {
      callConnector: async () => {
        throw new PendingVerificationError();
      },
      notify: (_session, text) => notices.push(text),
      operationContext: () => ({ instance: 'telegram', platformId: 'telegram:-1000000000001' }),
    });
    expect(notices).toEqual([expect.stringContaining('pending verification')]);
  });

  it('requires a live approval grant and derives stable operation keys', async () => {
    await expect(applyIdeaFeatureMutation(decisionContent(), session, null)).rejects.toThrow('live approval grant');
    expect(operationKeyFor('telegram', 'telegram:-100', 'event-1', 'idea_create')).toBe(
      operationKeyFor('telegram', 'telegram:-100', 'event-1', 'idea_create'),
    );
    expect(operationKeyFor('telegram', 'telegram:-100', 'event-1', 'idea_create')).not.toBe(
      operationKeyFor('telegram', 'telegram:-100', 'event-1', 'idea_reopen'),
    );
  });
});
