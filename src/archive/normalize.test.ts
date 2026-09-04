import { describe, expect, it } from 'vitest';

import { chatSlug, chunkMonth, normalizeTelegramMessage, normalizeWhatsAppMessage } from './normalize.js';

describe('normalize telegram', () => {
  const chat = { name: 'Работа', type: 'private_group', id: 123 };
  const batchId = 'b1';

  it('extracts plain text and unix timestamp', () => {
    const msg = normalizeTelegramMessage(
      {
        id: 7,
        type: 'message',
        date: '2024-05-01T12:34:56',
        date_unixtime: 1714566896,
        from: 'Alice',
        from_id: 'user123',
        text: 'hello world',
      },
      chat,
      '123',
      batchId,
    );
    expect(msg).toBeTruthy();
    expect(msg!.platform).toBe('telegram');
    expect(msg!.chat_jid).toBe('tg:private_group:123');
    expect(msg!.chat_title).toBe('Работа');
    expect(msg!.message_id).toBe('7');
    expect(msg!.text).toBe('hello world');
    expect(msg!.timestamp).toBe(new Date(1714566896 * 1000).toISOString());
    expect(msg!.sender_name).toBe('Alice');
    expect(msg!.raw_source_ref).toBe('telegram:tg:private_group:123:7');
    expect(msg!.is_from_me).toBe(true);
  });

  it('handles text_entities array and reply_to', () => {
    const msg = normalizeTelegramMessage(
      {
        id: 8,
        date_unixtime: 1,
        text: ['start ', { type: 'mention', text: '@foo' }, ' end'] as never,
        reply_to_message_id: 7,
      },
      chat,
      null,
      batchId,
    );
    expect(msg!.text).toBe('start @foo end');
    expect(msg!.reply_to).toBe('7');
    expect(msg!.is_from_me).toBe(false);
  });

  it('falls back to sticker_emoji when no text', () => {
    const msg = normalizeTelegramMessage({ id: 9, date_unixtime: 1, sticker_emoji: '👍' }, chat, null, batchId);
    expect(msg!.text).toBe('👍');
  });

  it('returns null without id or timestamp', () => {
    expect(normalizeTelegramMessage({ date_unixtime: 1 } as never, chat, null, batchId)).toBeNull();
    expect(normalizeTelegramMessage({ id: 1 } as never, chat, null, batchId)).toBeNull();
  });
});

describe('normalize whatsapp', () => {
  const chat = { name: 'Семья', messages: {} };
  const batchId = 'b1';

  it('maps a text message', () => {
    const m = normalizeWhatsAppMessage(
      '100',
      {
        from_me: false,
        timestamp: 1714566896,
        data: 'Привет',
        sender: '79001234567@s.whatsapp.net',
        key_id: 'KEY123',
      },
      '79990000000@g.us',
      chat,
      batchId,
    );
    expect(m).toBeTruthy();
    expect(m!.platform).toBe('whatsapp');
    expect(m!.chat_jid).toBe('79990000000@g.us');
    expect(m!.message_id).toBe('KEY123');
    expect(m!.text).toBe('Привет');
    expect(m!.sender_id).toBe('79001234567@s.whatsapp.net');
    expect(m!.is_from_me).toBe(false);
    expect(m!.raw_source_ref).toBe('whatsapp:79990000000@g.us:KEY123');
  });

  it('prefers caption when data is empty and marks media', () => {
    const m = normalizeWhatsAppMessage(
      '101',
      {
        timestamp: 1,
        data: null,
        caption: 'photo',
        media: true,
        mime: 'image/jpeg',
      },
      'x@g.us',
      chat,
      batchId,
    );
    expect(m!.text).toBe('photo');
    expect(m!.media_type).toBe('image/jpeg');
  });

  it('returns null without timestamp', () => {
    expect(normalizeWhatsAppMessage('a', {} as never, 'x@g.us', chat, batchId)).toBeNull();
  });
});

describe('chunk helpers', () => {
  it('chunkMonth returns YYYY-MM', () => {
    expect(chunkMonth('2024-05-01T12:00:00.000Z')).toBe('2024-05');
  });

  it('chatSlug sanitizes', () => {
    expect(chatSlug('tg:private:123')).toBe('tg_private_123');
    expect(chatSlug('phone+3@g.us')).toBe('phone_3_g.us');
  });
});
