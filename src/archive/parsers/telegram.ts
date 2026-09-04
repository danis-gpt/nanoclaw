import fs from 'fs';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';

import chain from 'stream-chain';
import parser from 'stream-json';
import pick from 'stream-json/filters/pick.js';
import streamArray from 'stream-json/streamers/stream-array.js';
import streamValues from 'stream-json/streamers/stream-values.js';

import { RawTelegramChat, RawTelegramMessage } from '../types.js';

export interface TelegramCallbacks {
  onChatStart?: (chat: RawTelegramChat) => void | Promise<void>;
  onMessage: (message: RawTelegramMessage, chat: RawTelegramChat) => void | Promise<void>;
  onChatEnd?: (chat: RawTelegramChat) => void | Promise<void>;
  onPersonalUserId?: (userId: string) => void;
}

/**
 * Streams a Telegram "full export" JSON.
 *
 * The file is opened as a read stream and never materialized as a single
 * parsed object, so heap stays bounded. Format:
 *   { personal_information: {...},
 *     chats: { list: [ { name, type, id, messages: [ ... ] }, ... ] } }
 */
export async function streamTelegramExport(filePath: string, cb: TelegramCallbacks): Promise<void> {
  if (cb.onPersonalUserId) {
    const userId = await pickScalar(filePath, 'personal_information.user_id');
    if (userId !== null) cb.onPersonalUserId(String(userId));
  }

  const source = fs.createReadStream(filePath);
  const pipe = chain([parser(), pick.asStream({ filter: 'chats.list' }), streamArray.asStream()]);

  const drain = new Writable({
    objectMode: true,
    write(item: { key: number; value: RawTelegramChat }, _enc: BufferEncoding, done: (err?: Error | null) => void) {
      const chat = item.value;
      const messages = Array.isArray(chat.messages) ? chat.messages : [];
      const chatHeader: RawTelegramChat = {
        name: chat.name ?? null,
        type: chat.type,
        id: chat.id,
      };
      (async () => {
        try {
          if (cb.onChatStart) await cb.onChatStart(chatHeader);
          for (const msg of messages) {
            await cb.onMessage(msg, chatHeader);
          }
          if (cb.onChatEnd) await cb.onChatEnd(chatHeader);
          done();
          // eslint-disable-next-line no-catch-all/no-catch-all -- this boundary has an explicit fallback for the failure
        } catch (err) {
          done(err as Error);
        }
      })().catch(done);
    },
  });

  await pipeline(source, pipe, drain);
}

async function pickScalar(filePath: string, dotPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let value: unknown = null;
    const source = fs.createReadStream(filePath);
    const pipe = chain([parser(), pick.asStream({ filter: dotPath }), streamValues.asStream()]);
    pipe.on('data', (item: { value: unknown }) => {
      value = item.value;
    });
    pipe.on('end', () => resolve(value));
    pipe.on('error', reject);
    source.on('error', reject);
    source.pipe(pipe);
  });
}
