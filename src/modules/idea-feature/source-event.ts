import { getMessagingGroup } from '../../db/messaging-groups.js';
import { openInboundDb } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { canAccessAgentGroup } from '../permissions/access.js';
import { getUser } from '../permissions/db/users.js';

interface StoredSourceEvent {
  id: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  source_session_id: string | null;
}

function fail(message: string): never {
  throw new Error(message);
}

function senderFromContent(raw: string): string {
  let content: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('source event content is invalid');
    content = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('source event')) throw error;
    return fail('source event content is invalid');
  }

  if (content.isFromMe === true) fail('source event is not a human Telegram message');
  const senderId = typeof content.senderId === 'string' ? content.senderId : null;
  const author =
    content.author && typeof content.author === 'object' && !Array.isArray(content.author)
      ? (content.author as Record<string, unknown>)
      : null;
  const authorUserId = typeof author?.userId === 'string' ? author.userId : null;
  if (senderId && authorUserId && senderId !== authorUserId) {
    fail('source event sender metadata is inconsistent');
  }
  const rawUserId = senderId ?? authorUserId;
  if (!rawUserId || rawUserId === 'system' || rawUserId === 'agent') {
    fail('source event sender metadata is missing');
  }
  if (rawUserId.includes(':') && !rawUserId.startsWith('telegram:')) {
    fail('source event sender is not Telegram');
  }
  return rawUserId.startsWith('telegram:') ? rawUserId : `telegram:${rawUserId}`;
}

/**
 * Resolve a model-supplied event reference against the host-owned inbound DB.
 * The returned identity comes exclusively from immutable routed metadata.
 */
export function verifySourceEvent(session: Session, sourceEventId: string): string {
  if (
    typeof sourceEventId !== 'string' ||
    sourceEventId.length < 1 ||
    sourceEventId.length > 512 ||
    !sourceEventId.endsWith(`:${session.agent_group_id}`)
  ) {
    fail('source event not found in requesting session');
  }
  if (session.status !== 'active' || session.messaging_group_id === null || session.thread_id?.startsWith('system:')) {
    fail('requesting session is not an active channel session');
  }
  const messagingGroup = getMessagingGroup(session.messaging_group_id);
  if (!messagingGroup || messagingGroup.channel_type !== 'telegram') {
    fail('requesting session is not a Telegram session');
  }

  let db: ReturnType<typeof openInboundDb>;
  try {
    db = openInboundDb(session.agent_group_id, session.id);
    // eslint-disable-next-line no-catch-all/no-catch-all -- an absent/unopenable session DB is indistinguishable from a missing source event
  } catch {
    return fail('source event not found in requesting session');
  }
  let row: StoredSourceEvent | undefined;
  try {
    row = db
      .prepare(
        `SELECT id, kind, platform_id, channel_type, thread_id, content, source_session_id
         FROM messages_in WHERE id = ? LIMIT 1`,
      )
      .get(sourceEventId) as StoredSourceEvent | undefined;
  } finally {
    db.close();
  }
  if (!row) fail('source event not found in requesting session');
  if (
    !['chat', 'chat-sdk'].includes(row.kind) ||
    row.channel_type !== 'telegram' ||
    row.platform_id !== messagingGroup.platform_id ||
    row.thread_id !== session.thread_id ||
    row.source_session_id !== null
  ) {
    fail('source event is not a human Telegram message');
  }

  const actorUserId = senderFromContent(row.content);
  const user = getUser(actorUserId);
  const access = canAccessAgentGroup(actorUserId, session.agent_group_id);
  if (!user || user.kind !== 'telegram' || !access.allowed) {
    fail('source event sender is not an active agent-group member');
  }
  return actorUserId;
}
