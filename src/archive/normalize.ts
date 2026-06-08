import { ArchivedMessage, RawTelegramChat, RawTelegramMessage, RawWhatsAppChat, RawWhatsAppMessage } from './types.js';

function telegramChatJid(chat: RawTelegramChat): string {
  const kind = (chat.type || 'private').toLowerCase();
  const id = chat.id ?? 'unknown';
  return `tg:${kind}:${id}`;
}

function telegramTextFromMessage(msg: RawTelegramMessage): string {
  if (typeof msg.text === 'string' && msg.text.length > 0) return msg.text;
  const source = Array.isArray(msg.text) ? msg.text : msg.text_entities;
  if (Array.isArray(source)) {
    const parts: string[] = [];
    for (const part of source) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && typeof part === 'object' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
    const joined = parts.join('').trim();
    if (joined) return joined;
  }
  if (msg.sticker_emoji) return msg.sticker_emoji;
  return '';
}

function telegramTimestamp(msg: RawTelegramMessage): string | null {
  if (msg.date_unixtime !== undefined) {
    const n = typeof msg.date_unixtime === 'number' ? msg.date_unixtime : parseInt(String(msg.date_unixtime), 10);
    if (Number.isFinite(n)) return new Date(n * 1000).toISOString();
  }
  if (msg.date) {
    // Telegram exports local date like "2024-01-02T15:04:05"; treat as UTC if no TZ info.
    // The unixtime field is the authoritative one; this branch is only a fallback.
    const parsed = new Date(msg.date);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

export function normalizeTelegramMessage(
  msg: RawTelegramMessage,
  chat: RawTelegramChat,
  ownerUserId: string | null,
  batchId: string,
): ArchivedMessage | null {
  const id = msg.id;
  if (id === undefined || id === null) return null;
  const ts = telegramTimestamp(msg);
  if (!ts) return null;

  const chat_jid = telegramChatJid(chat);
  const chat_title = chat.name ?? null;
  const message_id = String(id);
  const text = telegramTextFromMessage(msg);

  const sender_name = msg.from ?? msg.actor ?? null;
  const sender_id = msg.from_id ?? msg.actor_id ?? null;
  const is_from_me =
    ownerUserId !== null && sender_id !== null && sender_id.replace(/^user/, '') === ownerUserId.replace(/^user/, '');

  const media_type = msg.media_type ?? (msg.photo ? 'photo' : msg.file ? 'file' : null);
  const media_ref = msg.photo ?? msg.file ?? msg.file_name ?? null;
  const reply_to =
    msg.reply_to_message_id !== undefined && msg.reply_to_message_id !== null ? String(msg.reply_to_message_id) : null;

  return {
    platform: 'telegram',
    chat_jid,
    chat_title,
    message_id,
    timestamp: ts,
    sender_id,
    sender_name,
    text,
    reply_to,
    media_type,
    media_ref,
    raw_source_ref: `telegram:${chat_jid}:${message_id}`,
    import_batch_id: batchId,
    is_from_me,
  };
}

export function normalizeWhatsAppMessage(
  msgKey: string,
  msg: RawWhatsAppMessage,
  chatJid: string,
  chat: RawWhatsAppChat,
  batchId: string,
): ArchivedMessage | null {
  const tsNum = msg.timestamp;
  if (typeof tsNum !== 'number' || !Number.isFinite(tsNum)) return null;

  const message_id = msg.key_id || msgKey;
  const text =
    (typeof msg.data === 'string' ? msg.data : '') || (typeof msg.caption === 'string' ? msg.caption : '') || '';

  const chat_title = chat.name ?? null;
  const sender_id = msg.sender ?? null;
  const sender_name = msg.sender ?? null;
  const is_from_me = !!msg.from_me;

  let media_type: string | null = null;
  if (msg.media) {
    media_type = msg.mime || 'media';
  }

  const reply_to = typeof msg.reply === 'string' && msg.reply.length > 0 ? msg.reply : null;

  return {
    platform: 'whatsapp',
    chat_jid: chatJid,
    chat_title,
    message_id,
    timestamp: new Date(tsNum * 1000).toISOString(),
    sender_id,
    sender_name,
    text,
    reply_to,
    media_type,
    media_ref: null,
    raw_source_ref: `whatsapp:${chatJid}:${message_id}`,
    import_batch_id: batchId,
    is_from_me,
  };
}

export function chunkMonth(timestamp: string): string {
  // YYYY-MM from an ISO timestamp; falls back to 'unknown' on malformed input.
  const m = timestamp.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : 'unknown';
}

const SLUG_RE = /[^a-z0-9._-]+/gi;
export function chatSlug(chatJid: string): string {
  const cleaned = chatJid.replace(SLUG_RE, '_');
  return cleaned.slice(0, 120) || 'unknown';
}
