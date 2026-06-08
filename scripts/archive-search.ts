#!/usr/bin/env tsx
/**
 * CLI: full-text search over the archive index.
 *
 * Usage:
 *   tsx scripts/archive-search.ts "<query>" [--platform telegram|whatsapp]
 *                                           [--chat <jid>] [--limit N]
 *
 * The query syntax is SQLite FTS5's. Examples:
 *   "invoice payment"
 *   "pinecone OR qdrant"
 *   "\"exact phrase\""
 */
import { ArchiveDatabase } from '../src/archive/db.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  let platform: string | undefined;
  let chat: string | undefined;
  let limit = 20;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--platform') platform = args[++i];
    else if (a === '--chat') chat = args[++i];
    else if (a === '--limit') limit = parseInt(args[++i], 10);
    else positional.push(a);
  }
  if (positional.length === 0) {
    console.error(
      'Usage: archive-search "<query>" [--platform ...] [--chat ...] [--limit N]',
    );
    process.exit(2);
  }
  return { query: positional.join(' '), platform, chat, limit };
}

async function main() {
  const { query, platform, chat, limit } = parseArgs();
  const db = new ArchiveDatabase();
  try {
    const rows = db.search(query, { platform, chat_jid: chat, limit });
    for (const r of rows) {
      console.log(
        `[${r.timestamp}] ${r.platform} ${r.chat_title ?? r.chat_jid} — ${
          r.sender_name ?? '?'
        }`,
      );
      console.log(`  ${r.snippet}`);
    }
    if (rows.length === 0) console.log('(no matches)');
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('archive-search failed:', err);
  process.exit(1);
});
