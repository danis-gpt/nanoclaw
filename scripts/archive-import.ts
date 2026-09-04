#!/usr/bin/env tsx
/**
 * CLI: import a Telegram or WhatsApp export into the archive subsystem.
 *
 * Usage:
 *   tsx scripts/archive-import.ts --platform telegram --source <path>
 *   tsx scripts/archive-import.ts --platform whatsapp --source <path>
 */
import { ArchiveDatabase } from '../src/archive/db.js';
import { runImport } from '../src/archive/importer.js';
import { ArchivePlatform } from '../src/archive/types.js';

function parseArgs(): { platform: ArchivePlatform; source: string } {
  const args = process.argv.slice(2);
  let platform: string | undefined;
  let source: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--platform') platform = args[++i];
    else if (a === '--source') source = args[++i];
  }
  if (!platform || !source) {
    console.error(
      'Usage: archive-import --platform <telegram|whatsapp> --source <file.json>',
    );
    process.exit(2);
  }
  if (platform !== 'telegram' && platform !== 'whatsapp') {
    console.error(`Unknown platform: ${platform}`);
    process.exit(2);
  }
  return { platform, source };
}

async function main() {
  const { platform, source } = parseArgs();
  const db = new ArchiveDatabase();
  const start = Date.now();
  try {
    const result = await runImport({
      platform,
      source,
      db,
      onProgress: (p) => {
        const rate = p.seen / Math.max(1, (Date.now() - start) / 1000);
        process.stderr.write(
          `\r[${platform}] seen=${p.seen} inserted=${p.inserted} ` +
            `skipped=${p.skipped} chats=${p.chats} ` +
            `rate=${rate.toFixed(0)}/s last=${p.lastTimestamp ?? '?'}`,
        );
      },
    });
    process.stderr.write('\n');
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      JSON.stringify(
        {
          batchId: result.batchId,
          platform,
          source,
          seen: result.seen,
          inserted: result.inserted,
          skipped: result.skipped,
          chunks: result.chunks.length,
          duration_seconds: Number(dur),
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
  console.error('archive-import failed:', err);
  process.exit(1);
});
