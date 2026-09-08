import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-idea-feature-integration' };
});
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApproval, getPendingApprovalsByAction } from '../../db/sessions.js';
import { getDeliveryAction, setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole, revokeRole } from '../permissions/db/user-roles.js';
import './index.js';

const TEST_DIR = '/tmp/nanoclaw-test-idea-feature-integration';
const AGENT_GROUP_ID = 'ag-product';
const EVENT_ID = '-1000000000001:119:ag-product';
let session: Session;
let server: net.Server | null;
let socketDir: string | null;
let connectorCalls: Array<Record<string, unknown>>;

function now(): string {
  return new Date().toISOString();
}

const deliveryAdapter: ChannelDeliveryAdapter = {
  async deliver() {
    return 'telegram-card-1';
  },
};

async function seedUser(id: string, displayName: string): Promise<void> {
  await createUser({ id, kind: 'telegram', display_name: displayName, created_at: now() });
  await addMember({ user_id: id, agent_group_id: AGENT_GROUP_ID, added_by: null, added_at: now() });
  const handle = id.slice('telegram:'.length);
  await createMessagingGroup({
    id: `dm-${handle}`,
    channel_type: 'telegram',
    platform_id: `telegram:${handle}`,
    name: `${displayName} DM`,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({ user_id: id, channel_type: 'telegram', messaging_group_id: `dm-${handle}`, resolved_at: now() });
}

async function sourceEvent(): Promise<void> {
  await writeSessionMessage(AGENT_GROUP_ID, session.id, {
    id: EVENT_ID,
    kind: 'chat-sdk',
    timestamp: now(),
    platformId: 'telegram:-1000000000001',
    channelType: 'telegram',
    threadId: null,
    content: JSON.stringify({
      text: 'Please process this Idea',
      senderId: '119',
      author: { userId: '119', fullName: 'Requester' },
    }),
  });
}

function createContent(): Record<string, unknown> {
  return {
    action: 'idea_feature_request',
    payload: {
      operation: 'idea_create',
      sourceEventId: EVENT_ID,
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

function decisionContent(kind: 'product' | 'technical'): Record<string, unknown> {
  return {
    action: 'idea_feature_request',
    payload: {
      operation: kind === 'product' ? 'idea_record_product_decision' : 'idea_record_technical_decision',
      sourceEventId: EVENT_ID,
      request: {
        task_id: 'IDEA-1',
        decision_id: `${kind}-decision-1`,
        outcome: 'approved',
        comment: `${kind} approved`,
      },
    },
  };
}

async function startConnector(): Promise<void> {
  socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-feature-integration-'));
  const socketPath = path.join(socketDir, 'private.sock');
  server = net.createServer((socket) => {
    let pending = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      pending += chunk;
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(pending.slice(0, newline)) as Record<string, unknown>;
      connectorCalls.push(request);
      socket.end(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { applied: true, call: connectorCalls.length } })}\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => server!.listen(socketPath, resolve).once('error', reject));
  process.env.IDEA_FEATURE_PRIVATE_SOCKET = socketPath;
}

async function submit(
  content: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof getPendingApprovalsByAction>>[number]> {
  const action = getDeliveryAction('idea_feature_request');
  expect(action).toBeDefined();
  await action!(content, session);
  const rows = await getPendingApprovalsByAction('idea_feature_request');
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function click(approvalId: string, rawUserId: string): Promise<boolean> {
  return handleApprovalsResponse({
    questionId: approvalId,
    value: 'approve',
    userId: rawUserId,
    channelType: 'telegram',
    platformId: `telegram:${rawUserId}`,
    threadId: null,
  });
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Product',
    folder: 'product',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-product',
    channel_type: 'telegram',
    platform_id: 'telegram:-1000000000001',
    name: 'Product Telegram',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  session = {
    id: 'sess-product',
    agent_group_id: AGENT_GROUP_ID,
    messaging_group_id: 'mg-product',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  await seedUser('telegram:119', 'Requester');
  await seedUser('telegram:mikhail', 'Mikhail');
  await seedUser('telegram:danis', 'Danis');
  await grantRole({
    user_id: 'telegram:mikhail',
    role: 'product_approver',
    agent_group_id: AGENT_GROUP_ID,
    granted_by: null,
    granted_at: now(),
  });
  await grantRole({
    user_id: 'telegram:danis',
    role: 'technical_approver',
    agent_group_id: AGENT_GROUP_ID,
    granted_by: null,
    granted_at: now(),
  });
  await sourceEvent();
  connectorCalls = [];
  server = null;
  socketDir = null;
  setDeliveryAdapter(deliveryAdapter);
  process.env.IDEA_FEATURE_PRODUCT_AGENT_GROUP_ID = AGENT_GROUP_ID;
  await startConnector();
});

afterEach(async () => {
  delete process.env.IDEA_FEATURE_PRIVATE_SOCKET;
  delete process.env.IDEA_FEATURE_PRODUCT_AGENT_GROUP_ID;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Idea Feature approval wiring', () => {
  it('lets the requester confirm own create, rejects another member, and executes exactly once', async () => {
    const approval = await submit(createContent());
    expect(approval.approver_user_id).toBe('telegram:119');
    expect(Date.parse(approval.expires_at ?? '')).toBeGreaterThan(Date.now());

    await expect(click(approval.approval_id, 'danis')).resolves.toBe(true);
    expect(await getPendingApproval(approval.approval_id)).toBeDefined();
    expect(connectorCalls).toHaveLength(0);

    await expect(click(approval.approval_id, '119')).resolves.toBe(true);
    expect(await getPendingApproval(approval.approval_id)).toBeUndefined();
    expect(connectorCalls).toHaveLength(1);

    await expect(click(approval.approval_id, '119')).resolves.toBe(false);
    expect(connectorCalls).toHaveLength(1);
  });

  it('lets Mikhail resolve product but not Danis, and Danis resolve technical but not Mikhail', async () => {
    const product = await submit(decisionContent('product'));
    expect(product.approver_user_id).toBe('telegram:mikhail');
    await click(product.approval_id, 'danis');
    expect(connectorCalls).toHaveLength(0);
    await click(product.approval_id, 'mikhail');
    expect(connectorCalls).toHaveLength(1);

    const technical = await submit(decisionContent('technical'));
    expect(technical.approver_user_id).toBe('telegram:danis');
    await click(technical.approval_id, 'mikhail');
    expect(connectorCalls).toHaveLength(1);
    await click(technical.approval_id, 'danis');
    expect(connectorCalls).toHaveLength(2);
  });

  it('denies live when the domain role is revoked between card and click', async () => {
    const approval = await submit(decisionContent('product'));
    await revokeRole('telegram:mikhail', 'product_approver', AGENT_GROUP_ID);

    await click(approval.approval_id, 'mikhail');
    expect(await getPendingApproval(approval.approval_id)).toBeUndefined();
    expect(connectorCalls).toHaveLength(0);
  });
});
