#!/usr/bin/env tsx
/**
 * CLI: stage archive chunks into a group's wiki sources directory so the
 * existing `add-karpathy-llm-wiki` skill can ingest them incrementally.
 *
 * Usage:
 *   tsx scripts/archive-wiki.ts --group <folder> [--limit N]
 *
 * Each run processes up to --limit (default 5) chunks that have not been
 * marked as staged, so re-running resumes where the previous pass left off.
 */
import { ArchiveDatabase } from '../src/archive/db.js';
import { stageChunksForWiki } from '../src/archive/wiki.js';

function parseArgs() {
  const args = process.argv.slice(2);
  let group: string | undefined;
  let limit = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--group') group = args[++i];
    else if (args[i] === '--limit') limit = parseInt(args[++i], 10);
  }
  if (!group) {
    console.error('Usage: archive-wiki --group <folder> [--limit N]');
    process.exit(2);
  }
  return { group, limit };
}

async function main() {
  const { group, limit } = parseArgs();
  const db = new ArchiveDatabase();
  try {
    const { staged, dir } = await stageChunksForWiki({
      db,
      groupFolder: group,
      limit,
    });
    console.log(
      JSON.stringify(
        {
          staged: staged.length,
          dir,
          chunks: staged.map((c) => ({
            platform: c.platform,
            chat_jid: c.chat_jid,
            month: c.month,
            count: c.message_count,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('archive-wiki failed:', err);
  process.exit(1);
});
