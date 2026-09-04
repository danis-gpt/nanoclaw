import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-idea-feature-source-event' };
});

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessageInKind, Session } from '../../types.js';
import { addMember } from '../permissions/db/agent-group-members.js';
import { createUser } from '../permissions/db/users.js';
import { verifySourceEvent } from './source-event.js';

const TEST_DIR = '/tmp/nanoclaw-test-idea-feature-source-event';
const AGENT_GROUP_ID = 'ag-product';

function now(): string {
  return new Date().toISOString();
}

async function seedSession(id: string, messagingGroupId: string | null = 'mg-product'): Promise<Session> {
  const session: Session = {
    id,
    agent_group_id: AGENT_GROUP_ID,
    messaging_group_id: messagingGroupId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  return session;
}

async function writeEvent(
  session: Session,
  id: string,
  overrides: Partial<{
    kind: MessageInKind;
    channelType: string | null;
    platformId: string | null;
    content: Record<string, unknown>;
  }> = {},
): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id,
    kind: overrides.kind ?? 'chat-sdk',
    timestamp: now(),
    platformId: overrides.platformId === undefined ? 'telegram:-1000000000001' : overrides.platformId,
    channelType: overrides.channelType === undefined ? 'telegram' : overrides.channelType,
    threadId: null,
    content: JSON.stringify(
      overrides.content ?? {
        text: 'Create this idea',
        senderId: '119',
        author: { userId: '119', fullName: 'Requester' },
      },
    ),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
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
  await createUser({ id: 'telegram:119', kind: 'telegram', display_name: 'Requester', created_at: now() });
  await addMember({ user_id: 'telegram:119', agent_group_id: AGENT_GROUP_ID, added_by: null, added_at: now() });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('verifySourceEvent', () => {
  it('returns the namespaced user from the exact Telegram event in the requesting session', async () => {
    const session = await seedSession('sess-product');
    const eventId = `-1000000000001:119:${AGENT_GROUP_ID}`;
    await writeEvent(session, eventId);

    await expect(verifySourceEvent(session, eventId)).resolves.toBe('telegram:119');
  });

  it('denies missing, altered, and cross-session event IDs', async () => {
    const session = await seedSession('sess-product');
    const other = await seedSession('sess-other');
    const eventId = `-1000000000001:119:${AGENT_GROUP_ID}`;
    await writeEvent(other, eventId);

    await expect(verifySourceEvent(session, eventId)).rejects.toThrow('source event not found');
    await expect(verifySourceEvent(other, `${eventId}-altered`)).rejects.toThrow('source event not found');
  });

  it.each([
    ['scheduled task', { kind: 'task', channelType: 'telegram', content: { senderId: '119' } }],
    ['session echo', { kind: 'chat', channelType: 'agent', content: { senderId: 'system' } }],
    ['CLI message', { kind: 'chat', channelType: 'cli', content: { senderId: 'cli:admin' } }],
  ])('denies a %s row', async (_label, overrides) => {
    const session = await seedSession(`sess-${String(_label).replaceAll(' ', '-')}`);
    const eventId = `event-${String(_label).replaceAll(' ', '-')}:${AGENT_GROUP_ID}`;
    await writeEvent(session, eventId, overrides as Parameters<typeof writeEvent>[2]);
    await expect(verifySourceEvent(session, eventId)).rejects.toThrow('source event is not a human Telegram message');
  });

  it('denies inconsistent or model-like sender metadata', async () => {
    const session = await seedSession('sess-product');
    const eventId = `event-inconsistent:${AGENT_GROUP_ID}`;
    await writeEvent(session, eventId, { content: { senderId: '119', author: { userId: '999' } } });
    await expect(verifySourceEvent(session, eventId)).rejects.toThrow('source event sender metadata is inconsistent');
  });

  it('denies a Telegram sender who is not an active Product group member', async () => {
    const session = await seedSession('sess-product');
    await createUser({ id: 'telegram:404', kind: 'telegram', display_name: null, created_at: now() });
    const eventId = `event-nonmember:${AGENT_GROUP_ID}`;
    await writeEvent(session, eventId, { content: { senderId: '404' } });
    await expect(verifySourceEvent(session, eventId)).rejects.toThrow(
      'source event sender is not an active agent-group member',
    );
  });
});
