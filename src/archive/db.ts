import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ArchivedMessage, ChunkRef, ImportBatch } from './types.js';
import { ARCHIVE_DB_PATH } from './paths.js';

/**
 * A separate SQLite database for the archive subsystem so imports cannot
 * bloat the live operational `store/messages.db`. FTS5 is used for keyword
 * search over text/sender/chat_title; `raw_source_ref` is UNIQUE, which gives
 * us dedup on re-ingest at the SQL layer via `INSERT OR IGNORE`.
 */
export class ArchiveDatabase {
  readonly db: Database.Database;

  constructor(dbPath: string = ARCHIVE_DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archive_messages (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        chat_title TEXT,
        message_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        text TEXT,
        reply_to TEXT,
        media_type TEXT,
        media_ref TEXT,
        raw_source_ref TEXT NOT NULL UNIQUE,
        import_batch_id TEXT NOT NULL,
        is_from_me INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_archive_chat_time
        ON archive_messages(chat_jid, timestamp);
      CREATE INDEX IF NOT EXISTS idx_archive_batch
        ON archive_messages(import_batch_id);
      CREATE INDEX IF NOT EXISTS idx_archive_platform_time
        ON archive_messages(platform, timestamp);

      CREATE VIRTUAL TABLE IF NOT EXISTS archive_messages_fts USING fts5(
        text, sender_name, chat_title,
        content='archive_messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS archive_messages_ai
        AFTER INSERT ON archive_messages BEGIN
          INSERT INTO archive_messages_fts(rowid, text, sender_name, chat_title)
          VALUES (new.rowid, new.text, new.sender_name, new.chat_title);
        END;
      CREATE TRIGGER IF NOT EXISTS archive_messages_ad
        AFTER DELETE ON archive_messages BEGIN
          INSERT INTO archive_messages_fts(archive_messages_fts, rowid, text, sender_name, chat_title)
          VALUES ('delete', old.rowid, old.text, old.sender_name, old.chat_title);
        END;
      CREATE TRIGGER IF NOT EXISTS archive_messages_au
        AFTER UPDATE ON archive_messages BEGIN
          INSERT INTO archive_messages_fts(archive_messages_fts, rowid, text, sender_name, chat_title)
          VALUES ('delete', old.rowid, old.text, old.sender_name, old.chat_title);
          INSERT INTO archive_messages_fts(rowid, text, sender_name, chat_title)
          VALUES (new.rowid, new.text, new.sender_name, new.chat_title);
        END;

      CREATE TABLE IF NOT EXISTS archive_batches (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        source_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        messages_seen INTEGER NOT NULL DEFAULT 0,
        messages_inserted INTEGER NOT NULL DEFAULT 0,
        messages_skipped INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS archive_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        chat_title TEXT,
        month TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        message_count INTEGER NOT NULL DEFAULT 0,
        min_timestamp TEXT,
        max_timestamp TEXT,
        wiki_ingested_at TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createBatch(batch: ImportBatch): void {
    this.db
      .prepare(
        `INSERT INTO archive_batches
           (id, platform, source_path, started_at, finished_at,
            messages_seen, messages_inserted, messages_skipped, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batch.id,
        batch.platform,
        batch.source_path,
        batch.started_at,
        batch.finished_at,
        batch.messages_seen,
        batch.messages_inserted,
        batch.messages_skipped,
        batch.status,
        batch.error,
      );
  }

  finishBatch(
    id: string,
    data: Pick<
      ImportBatch,
      'finished_at' | 'messages_seen' | 'messages_inserted' | 'messages_skipped' | 'status' | 'error'
    >,
  ): void {
    this.db
      .prepare(
        `UPDATE archive_batches SET
           finished_at = ?, messages_seen = ?, messages_inserted = ?,
           messages_skipped = ?, status = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        data.finished_at,
        data.messages_seen,
        data.messages_inserted,
        data.messages_skipped,
        data.status,
        data.error,
        id,
      );
  }

  /**
   * Inserts a batch of messages inside a single transaction. Uses INSERT OR
   * IGNORE against the `raw_source_ref` UNIQUE index so re-imports are safe
   * and cheap.
   *
   * Returns {inserted, skipped} where skipped = seen - inserted.
   */
  insertMessages(messages: ArchivedMessage[]): {
    inserted: number;
    skipped: number;
  } {
    if (messages.length === 0) return { inserted: 0, skipped: 0 };
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO archive_messages
         (platform, chat_jid, chat_title, message_id, timestamp,
          sender_id, sender_name, text, reply_to, media_type, media_ref,
          raw_source_ref, import_batch_id, is_from_me)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: ArchivedMessage[]) => {
      let inserted = 0;
      for (const m of rows) {
        const info = stmt.run(
          m.platform,
          m.chat_jid,
          m.chat_title,
          m.message_id,
          m.timestamp,
          m.sender_id,
          m.sender_name,
          m.text,
          m.reply_to,
          m.media_type,
          m.media_ref,
          m.raw_source_ref,
          m.import_batch_id,
          m.is_from_me ? 1 : 0,
        );
        if (info.changes > 0) inserted += 1;
      }
      return inserted;
    });
    const inserted = tx(messages);
    return { inserted, skipped: messages.length - inserted };
  }

  recordChunk(chunk: Omit<ChunkRef, 'id' | 'wiki_ingested_at'>): void {
    this.db
      .prepare(
        `INSERT INTO archive_chunks
           (platform, chat_jid, chat_title, month, path,
            message_count, min_timestamp, max_timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           message_count = message_count + excluded.message_count,
           min_timestamp = MIN(min_timestamp, excluded.min_timestamp),
           max_timestamp = MAX(max_timestamp, excluded.max_timestamp),
           chat_title    = COALESCE(excluded.chat_title, chat_title)`,
      )
      .run(
        chunk.platform,
        chunk.chat_jid,
        chunk.chat_title,
        chunk.month,
        chunk.path,
        chunk.message_count,
        chunk.min_timestamp,
        chunk.max_timestamp,
      );
  }

  listChunks(opts?: { wikiPending?: boolean; platform?: string; chat_jid?: string; limit?: number }): ChunkRef[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (opts?.wikiPending) clauses.push('wiki_ingested_at IS NULL');
    if (opts?.platform) {
      clauses.push('platform = ?');
      args.push(opts.platform);
    }
    if (opts?.chat_jid) {
      clauses.push('chat_jid = ?');
      args.push(opts.chat_jid);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = opts?.limit ? `LIMIT ${opts.limit}` : '';
    return this.db
      .prepare(
        `SELECT id, platform, chat_jid, chat_title, month, path,
                message_count, min_timestamp, max_timestamp, wiki_ingested_at
         FROM archive_chunks ${where}
         ORDER BY platform, chat_jid, month ${limit}`,
      )
      .all(...args) as ChunkRef[];
  }

  markChunkIngested(chunkId: number): void {
    this.db
      .prepare(`UPDATE archive_chunks SET wiki_ingested_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), chunkId);
  }

  rebuildFts(): void {
    this.db.exec(`
      INSERT INTO archive_messages_fts(archive_messages_fts) VALUES ('rebuild');
    `);
  }

  search(
    query: string,
    opts?: { limit?: number; platform?: string; chat_jid?: string },
  ): Array<{
    rowid: number;
    platform: string;
    chat_jid: string;
    chat_title: string | null;
    timestamp: string;
    sender_name: string | null;
    snippet: string;
    text: string;
  }> {
    const limit = opts?.limit ?? 50;
    const extras: string[] = [];
    const args: unknown[] = [query];
    if (opts?.platform) {
      extras.push('m.platform = ?');
      args.push(opts.platform);
    }
    if (opts?.chat_jid) {
      extras.push('m.chat_jid = ?');
      args.push(opts.chat_jid);
    }
    const where = extras.length ? `AND ${extras.join(' AND ')}` : '';
    args.push(limit);
    return this.db
      .prepare(
        `SELECT m.rowid AS rowid, m.platform, m.chat_jid, m.chat_title,
                m.timestamp, m.sender_name, m.text,
                snippet(archive_messages_fts, 0, '«', '»', '…', 12) AS snippet
         FROM archive_messages_fts
         JOIN archive_messages m ON m.rowid = archive_messages_fts.rowid
         WHERE archive_messages_fts MATCH ? ${where}
         ORDER BY m.timestamp DESC
         LIMIT ?`,
      )
      .all(...args) as Array<{
      rowid: number;
      platform: string;
      chat_jid: string;
      chat_title: string | null;
      timestamp: string;
      sender_name: string | null;
      snippet: string;
      text: string;
    }>;
  }
}
