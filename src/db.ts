import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env } from './env';
import { logger } from './log';

const log = logger('db');

mkdirSync(env.DATA_DIR, { recursive: true });
const file = join(env.DATA_DIR, 'gork.db');
const old = join(env.DATA_DIR, 'archive.db');

// the stats used to share archive.db with the message archive; keep them, lose the rest
if (!existsSync(file) && existsSync(old)) {
  const legacy = new DatabaseSync(old);
  legacy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  legacy.close();
  renameSync(old, file);
  rmSync(`${old}-wal`, { force: true });
  rmSync(`${old}-shm`, { force: true });
}

/** Stats only. gork doesn't store chat or notes about people anymore. */
export const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
`);

const leftovers = (
  db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('messages', 'messages_fts', 'crawl', 'notes')`)
    .all() as { name: string }[]
).map((t) => t.name);
if (leftovers.length) {
  db.exec(`
    DROP TABLE IF EXISTS messages_fts;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS crawl;
    DROP TABLE IF EXISTS notes;
  `);
  // actually give the space (and the old chat) back instead of leaving it in free pages,
  // and checkpoint so the rewritten file replaces the old one on disk right away
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  log.info(`deleted the old message archive and notes (${leftovers.join(', ')})`);
}
