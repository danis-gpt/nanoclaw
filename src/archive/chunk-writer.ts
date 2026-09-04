import fs from 'fs';
import path from 'path';

import { ArchivedMessage, ArchivePlatform } from './types.js';
import { chatSlug, chunkMonth } from './normalize.js';

interface OpenChunk {
  absPath: string;
  relPath: string;
  stream: fs.WriteStream;
  platform: ArchivePlatform;
  chat_jid: string;
  chat_title: string | null;
  month: string;
  count: number;
  min_ts: string;
  max_ts: string;
}

/**
 * Writes normalized messages to NDJSON chunk files keyed by
 * platform/chat/month. Keeps at most MAX_OPEN_HANDLES files open at once and
 * evicts the least-recently-used chunk when the cap is hit.
 */
export class ChunkWriter {
  private open = new Map<string, OpenChunk>();
  private readonly maxOpen: number;
  private readonly finalized: OpenChunk[] = [];

  constructor(
    private readonly rawDir: string,
    maxOpenHandles = 32,
  ) {
    this.maxOpen = maxOpenHandles;
    fs.mkdirSync(rawDir, { recursive: true });
  }

  async write(msg: ArchivedMessage): Promise<void> {
    const month = chunkMonth(msg.timestamp);
    const slug = chatSlug(msg.chat_jid);
    const key = `${msg.platform}/${slug}/${month}`;
    const existing = this.open.get(key);
    const chunk = existing || (await this.openChunk(msg, key, slug, month));
    // LRU touch
    this.open.delete(key);
    this.open.set(key, chunk);

    chunk.stream.write(`${JSON.stringify(msg)}\n`);
    chunk.count += 1;
    if (msg.timestamp < chunk.min_ts) chunk.min_ts = msg.timestamp;
    if (msg.timestamp > chunk.max_ts) chunk.max_ts = msg.timestamp;
    if (chunk.chat_title === null && msg.chat_title) {
      chunk.chat_title = msg.chat_title;
    }

    if (this.open.size > this.maxOpen) {
      const oldestKey = this.open.keys().next().value as string | undefined;
      if (oldestKey && oldestKey !== key) {
        const oldest = this.open.get(oldestKey)!;
        this.open.delete(oldestKey);
        await this.closeChunk(oldest);
      }
    }
  }

  private async openChunk(msg: ArchivedMessage, key: string, slug: string, month: string): Promise<OpenChunk> {
    const dir = path.join(this.rawDir, msg.platform, slug);
    fs.mkdirSync(dir, { recursive: true });
    const absPath = path.join(dir, `${month}.ndjson`);
    const relPath = path.relative(this.rawDir, absPath);
    // Append mode so a resumed import adds to the existing chunk.
    const stream = fs.createWriteStream(absPath, { flags: 'a' });
    const chunk: OpenChunk = {
      absPath,
      relPath,
      stream,
      platform: msg.platform,
      chat_jid: msg.chat_jid,
      chat_title: msg.chat_title,
      month,
      count: 0,
      min_ts: msg.timestamp,
      max_ts: msg.timestamp,
    };
    this.open.set(key, chunk);
    return chunk;
  }

  private async closeChunk(chunk: OpenChunk): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      chunk.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    this.finalized.push(chunk);
  }

  async finalizeAll(): Promise<OpenChunk[]> {
    for (const chunk of this.open.values()) {
      await this.closeChunk(chunk);
    }
    this.open.clear();
    return this.finalized;
  }
}

export type FinalizedChunk = OpenChunk;
