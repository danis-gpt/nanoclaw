import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArchiveDatabase } from './db.js';
import { runImport } from './importer.js';

/**
 * Integration-style tests that exercise the full streaming pipeline end-to-end
 * on small synthetic fixtures: parser → normalize → chunk → FTS DB.
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeTelegramFixture(file: string, messageCount: number, chatName = 'Test chat'): void {
  const messages: unknown[] = [];
  for (let i = 1; i <= messageCount; i++) {
    messages.push({
      id: i,
      type: 'message',
      date: '2024-01-01T00:00:00',
      date_unixtime: 1704067200 + i,
      from: `User ${i % 3}`,
      from_id: `user${i % 3}`,
      text: `telegram message number ${i} about pineapple`,
    });
  }
  fs.writeFileSync(
    file,
    JSON.stringify({
      about: 'test',
      personal_information: { user_id: 0 },
      chats: {
        list: [
          {
            name: chatName,
            type: 'personal_chat',
            id: 42,
            messages,
          },
        ],
      },
    }),
  );
}

function writeWhatsAppFixture(file: string, messageCount: number): void {
  const messages: Record<string, unknown> = {};
  for (let i = 1; i <= messageCount; i++) {
    messages[`${i}`] = {
      from_me: i % 2 === 0,
      timestamp: 1704067200 + i,
      data: `whatsapp text ${i} mango`,
      key_id: `K${i}`,
      media: false,
    };
  }
  fs.writeFileSync(
    file,
    JSON.stringify({
      '123@g.us': { name: 'Group', type: 'android', messages },
    }),
  );
}

describe('runImport telegram', () => {
  it('ingests a telegram fixture end-to-end', async () => {
    const src = path.join(tmpRoot, 'tg.json');
    writeTelegramFixture(src, 50);
    const db = new ArchiveDatabase(path.join(tmpRoot, 'a.db'));
    const res = await runImport({
      platform: 'telegram',
      source: src,
      db,
      rawDir: path.join(tmpRoot, 'raw'),
      batchSize: 10,
    });
    expect(res.seen).toBe(50);
    expect(res.inserted).toBe(50);
    expect(res.skipped).toBe(0);
    expect(res.chunks.length).toBeGreaterThan(0);

    const hits = db.search('pineapple');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].platform).toBe('telegram');

    db.close();
  });

  it('deduplicates on re-import of the same file', async () => {
    const src = path.join(tmpRoot, 'tg.json');
    writeTelegramFixture(src, 30);
    const dbPath = path.join(tmpRoot, 'a.db');
    const raw = path.join(tmpRoot, 'raw');

    const db1 = new ArchiveDatabase(dbPath);
    const r1 = await runImport({
      platform: 'telegram',
      source: src,
      db: db1,
      rawDir: raw,
    });
    db1.close();

    const db2 = new ArchiveDatabase(dbPath);
    const r2 = await runImport({
      platform: 'telegram',
      source: src,
      db: db2,
      rawDir: raw,
    });
    expect(r1.inserted).toBe(30);
    expect(r2.inserted).toBe(0);
    expect(r2.skipped).toBe(30);
    db2.close();
  });
});

describe('runImport whatsapp', () => {
  it('ingests a whatsapp fixture and makes messages searchable', async () => {
    const src = path.join(tmpRoot, 'wa.json');
    writeWhatsAppFixture(src, 20);
    const db = new ArchiveDatabase(path.join(tmpRoot, 'a.db'));
    const res = await runImport({
      platform: 'whatsapp',
      source: src,
      db,
      rawDir: path.join(tmpRoot, 'raw'),
    });
    expect(res.seen).toBe(20);
    expect(res.inserted).toBe(20);
    const hits = db.search('mango');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].platform).toBe('whatsapp');
    db.close();
  });
});
