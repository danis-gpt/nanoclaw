import fs from 'fs';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';

import chain from 'stream-chain';
import parser from 'stream-json';
import streamObject from 'stream-json/streamers/stream-object.js';

import { RawWhatsAppChat, RawWhatsAppMessage } from '../types.js';

export interface WhatsAppCallbacks {
  onChatStart?: (chatJid: string, chat: RawWhatsAppChat) => void | Promise<void>;
  onMessage: (
    messageKey: string,
    message: RawWhatsAppMessage,
    chatJid: string,
    chat: RawWhatsAppChat,
  ) => void | Promise<void>;
  onChatEnd?: (chatJid: string, chat: RawWhatsAppChat) => void | Promise<void>;
}

/**
 * Streams a WhatsApp export JSON. Format:
 *   { "<chat_jid>": { name, type, messages: { "<msg_id>": {...}, ... } }, ... }
 *
 * `streamObject` yields each top-level key/value pair without building the
 * full root object. The inner `messages` map is still materialized inside
 * the chat value — fine in practice, as the largest single chat fits well
 * under the Node heap limit.
 */
export async function streamWhatsAppExport(filePath: string, cb: WhatsAppCallbacks): Promise<void> {
  const source = fs.createReadStream(filePath);
  const pipe = chain([parser(), streamObject.asStream()]);

  const drain = new Writable({
    objectMode: true,
    write(item: { key: string; value: RawWhatsAppChat }, _enc: BufferEncoding, done: (err?: Error | null) => void) {
      const chatJid = item.key;
      const chat = item.value || {};
      const messages = chat.messages || {};
      (async () => {
        try {
          if (cb.onChatStart) await cb.onChatStart(chatJid, chat);
          for (const [msgKey, msg] of Object.entries(messages)) {
            await cb.onMessage(msgKey, msg as RawWhatsAppMessage, chatJid, chat);
          }
          if (cb.onChatEnd) await cb.onChatEnd(chatJid, chat);
          done();
        } catch (err) {
          done(err as Error);
        }
      })().catch(done);
    },
  });

  await pipeline(source, pipe, drain);
}
