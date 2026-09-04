import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { ArchiveDatabase } from './db.js';
import { ChunkWriter, FinalizedChunk } from './chunk-writer.js';
import { normalizeTelegramMessage, normalizeWhatsAppMessage } from './normalize.js';
import { streamTelegramExport } from './parsers/telegram.js';
import { streamWhatsAppExport } from './parsers/whatsapp.js';
import { ARCHIVE_RAW_DIR } from './paths.js';
import { ArchivedMessage, ArchivePlatform, ImporterProgress } from './types.js';

export interface ImporterOptions {
  platform: ArchivePlatform;
  source: string;
  db: ArchiveDatabase;
  rawDir?: string;
  batchSize?: number;
  progressEvery?: number;
  onProgress?: (p: ImporterProgress) => void;
}

/**
 * Orchestrates streaming ingest from a platform-specific parser into both
 * NDJSON chunk files and the archive FTS DB. The pipeline keeps at most
 * `batchSize` normalized messages in memory before flushing a single DB
 * transaction, so total heap usage is roughly O(batchSize + max_open_chunks).
 */
export async function runImport(opts: ImporterOptions): Promise<{
  batchId: string;
  seen: number;
  inserted: number;
  skipped: number;
  chunks: FinalizedChunk[];
}> {
  const source = path.resolve(opts.source);
  if (!fs.existsSync(source)) {
    throw new Error(`archive source not found: ${source}`);
  }

  const batchId = `${opts.platform}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const batchSize = opts.batchSize ?? 2000;
  const progressEvery = opts.progressEvery ?? 10000;

  const writer = new ChunkWriter(opts.rawDir ?? ARCHIVE_RAW_DIR);
  opts.db.createBatch({
    id: batchId,
    platform: opts.platform,
    source_path: source,
    started_at: new Date().toISOString(),
    finished_at: null,
    messages_seen: 0,
    messages_inserted: 0,
    messages_skipped: 0,
    status: 'running',
    error: null,
  });

  let buffer: ArchivedMessage[] = [];
  let seen = 0;
  let inserted = 0;
  let skipped = 0;
  let chats = 0;
  let lastTs: string | undefined;

  const flush = () => {
    if (buffer.length === 0) return;
    const res = opts.db.insertMessages(buffer);
    inserted += res.inserted;
    skipped += res.skipped;
    buffer = [];
  };

  const onNormalized = async (msg: ArchivedMessage) => {
    seen += 1;
    lastTs = msg.timestamp;
    buffer.push(msg);
    await writer.write(msg);
    if (buffer.length >= batchSize) flush();
    if (opts.onProgress && seen % progressEvery === 0) {
      opts.onProgress({ seen, inserted, skipped, chats, lastTimestamp: lastTs });
    }
  };

  try {
    if (opts.platform === 'telegram') {
      let ownerId: string | null = null;
      await streamTelegramExport(source, {
        onPersonalUserId: (u) => {
          ownerId = u;
        },
        onChatStart: () => {
          chats += 1;
        },
        onMessage: async (raw, chat) => {
          const norm = normalizeTelegramMessage(raw, chat, ownerId, batchId);
          if (norm) await onNormalized(norm);
        },
      });
    } else {
      await streamWhatsAppExport(source, {
        onChatStart: () => {
          chats += 1;
        },
        onMessage: async (msgKey, raw, chatJid, chat) => {
          const norm = normalizeWhatsAppMessage(msgKey, raw, chatJid, chat, batchId);
          if (norm) await onNormalized(norm);
        },
      });
    }

    flush();
    const finalized = await writer.finalizeAll();
    for (const c of finalized) {
      opts.db.recordChunk({
        platform: c.platform,
        chat_jid: c.chat_jid,
        chat_title: c.chat_title,
        month: c.month,
        path: c.relPath,
        message_count: c.count,
        min_timestamp: c.min_ts,
        max_timestamp: c.max_ts,
      });
    }

    opts.db.finishBatch(batchId, {
      finished_at: new Date().toISOString(),
      messages_seen: seen,
      messages_inserted: inserted,
      messages_skipped: skipped,
      status: 'completed',
      error: null,
    });

    if (opts.onProgress) {
      opts.onProgress({ seen, inserted, skipped, chats, lastTimestamp: lastTs });
    }

    return { batchId, seen, inserted, skipped, chunks: finalized };
  } catch (err) {
    flush();
    await writer.finalizeAll().catch(() => undefined);
    opts.db.finishBatch(batchId, {
      finished_at: new Date().toISOString(),
      messages_seen: seen,
      messages_inserted: inserted,
      messages_skipped: skipped,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
