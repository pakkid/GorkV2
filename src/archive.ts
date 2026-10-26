import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TextBasedChannel } from 'discord.js';
import { archive as cfg } from './config';
import { env } from './env';
import { type ChatMsg, cmpId, formatTime, toChatMsg } from './history';
import { logger } from './log';

const log = logger('archive');

mkdirSync(env.DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(env.DATA_DIR, 'archive.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reply_to TEXT
  );
  CREATE INDEX IF NOT EXISTS messages_channel_time ON messages (channel_id, created_at);
  CREATE INDEX IF NOT EXISTS messages_channel_author ON messages (channel_id, author_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
    body, author, content = 'messages', content_rowid = 'rowid',
    tokenize = 'porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, body, author) VALUES (new.rowid, new.body, new.author);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, body, author) VALUES ('delete', old.rowid, old.body, old.author);
  END;
  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, body, author) VALUES ('delete', old.rowid, old.body, old.author);
    INSERT INTO messages_fts (rowid, body, author) VALUES (new.rowid, new.body, new.author);
  END;

  -- how far back the history crawl has gotten per channel
  CREATE TABLE IF NOT EXISTS crawl (
    channel_id TEXT PRIMARY KEY,
    before_id TEXT,
    count INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0
  );
`);

function bodyOf(m: ChatMsg) {
  const tags = [
    ...m.attachments.map((a) => `${a.type.startsWith('image/') ? 'image' : 'file'}: ${a.name}`),
    ...m.extras,
  ];
  return `${m.content}${tags.length ? ` [${tags.join('] [')}]` : ''}`;
}

function authorOf(m: ChatMsg) {
  if (m.self) return 'gork';
  return m.username.toLowerCase() === m.name.toLowerCase() ? m.name : `${m.name} (@${m.username})`;
}

const upsert = db.prepare(`
  INSERT INTO messages (id, channel_id, author_id, author, body, created_at, reply_to)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (id) DO UPDATE SET body = excluded.body, author = excluded.author
  WHERE body != excluded.body OR author != excluded.author
`);
const insertIgnore = db.prepare(`
  INSERT OR IGNORE INTO messages (id, channel_id, author_id, author, body, created_at, reply_to)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const remove = db.prepare('DELETE FROM messages WHERE id = ?');

function row(channelId: string, m: ChatMsg) {
  return [m.id, channelId, m.authorId, authorOf(m), bodyOf(m), m.createdAt, m.replyToId ?? null] as const;
}

export function archiveMessage(channelId: string, m: ChatMsg) {
  try {
    upsert.run(...row(channelId, m));
  } catch (error) {
    log.warn('archive write failed', error);
  }
}

export function archiveMany(channelId: string, msgs: ChatMsg[]) {
  if (!msgs.length) return;
  db.exec('BEGIN');
  try {
    for (const m of msgs) insertIgnore.run(...row(channelId, m));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    log.warn('archive batch failed', error);
  }
}

export function unarchive(id: string) {
  remove.run(id);
}

// ---------------------------------------------------------------------------
// full history crawl: walks each channel back to its first message, gently

const crawlGet = db.prepare('SELECT before_id, count, done FROM crawl WHERE channel_id = ?');
const crawlSet = db.prepare(`
  INSERT INTO crawl (channel_id, before_id, count, done) VALUES (?, ?, ?, ?)
  ON CONFLICT (channel_id) DO UPDATE SET before_id = excluded.before_id, count = excluded.count, done = excluded.done
`);
const oldestStmt = db.prepare('SELECT MIN(created_at) t, id FROM messages WHERE channel_id = ?');

const existsStmt = db.prepare('SELECT 1 FROM messages WHERE id = ?');
const olderStmt = db.prepare('SELECT 1 FROM messages WHERE channel_id = ? AND created_at < ? LIMIT 1');

type Job = { channel: TextBasedChannel; run: () => Promise<void> };
const queue: Job[] = [];
const queued = new Set<string>();
let crawling = false;

function enqueue(key: string, channel: TextBasedChannel, run: () => Promise<void>) {
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ channel, run });
  void pump();
}

async function pump() {
  if (crawling) return;
  crawling = true;
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      await job.run().catch((error) => log.warn(`crawl of ${job.channel.id} stopped`, error));
    }
  } finally {
    crawling = false;
  }
}

/** Queue a crawl of the channel's entire history (resumes where it left off). */
export function crawlChannel(channel: TextBasedChannel) {
  if (!cfg.crawl) return;
  const state = crawlGet.get(channel.id) as { done: number } | undefined;
  if (state?.done) return;
  enqueue(`crawl:${channel.id}`, channel, () => crawl(channel));
}

/**
 * Archive the latest page fetched on startup. If gork was offline long enough that it
 * doesn't connect to what's already archived, backfill the gap too.
 */
export function archiveRecent(channel: TextBasedChannel, msgs: ChatMsg[]) {
  const oldest = msgs[0];
  const gap =
    oldest &&
    msgs.length >= 100 &&
    !existsStmt.get(oldest.id) &&
    olderStmt.get(channel.id, oldest.createdAt);
  archiveMany(channel.id, msgs);
  if (gap) enqueue(`gap:${channel.id}`, channel, () => fillGap(channel, oldest.id));
}

async function fillGap(channel: TextBasedChannel, from: string) {
  let before = from;
  let count = 0;
  for (let page = 0; page < cfg.maxGapPages; page++) {
    const fetched = await channel.messages.fetch({ limit: 100, before });
    const msgs = [...fetched.values()];
    const known = msgs.some((m) => existsStmt.get(m.id));
    archiveMany(channel.id, msgs.filter((m) => !m.content.startsWith('//')).map(toChatMsg));
    count += msgs.length;
    const oldest = [...fetched.keys()].sort(cmpId)[0];
    if (known || !oldest || fetched.size < 100) break;
    before = oldest;
    await sleep(cfg.crawlDelayMs);
  }
  log.info(`filled ${count} msg gap in ${channel.id}`);
}

async function crawl(channel: TextBasedChannel) {
  const state = crawlGet.get(channel.id) as
    | { before_id: string | null; count: number; done: number }
    | undefined;
  let before = state?.before_id ?? (oldestStmt.get(channel.id) as { id: string | null }).id ?? undefined;
  let count = state?.count ?? 0;
  const started = Date.now();
  log.info(`crawling history of ${channel.id} from ${before ?? 'latest'}`);

  while (count < cfg.maxPerChannel) {
    const page = await channel.messages.fetch({ limit: 100, before });
    const msgs = [...page.values()].filter((m) => !m.content.startsWith('//'));
    archiveMany(channel.id, msgs.map(toChatMsg));
    count += page.size;
    const oldest = [...page.keys()].sort(cmpId)[0];
    const done = page.size < 100 || !oldest;
    crawlSet.run(channel.id, oldest ?? before ?? null, count, done ? 1 : 0);
    if (done) break;
    before = oldest;
    await sleep(cfg.crawlDelayMs);
  }
  log.info(`crawled ${count} msgs in ${channel.id} (${Math.round((Date.now() - started) / 1000)}s)`);
}

// ---------------------------------------------------------------------------
// search

interface Row {
  id: string;
  author: string;
  body: string;
  created_at: number;
}

const ftsSearch = db.prepare(`
  SELECT m.id, m.author, m.body, m.created_at
  FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
  WHERE messages_fts MATCH ? AND m.channel_id = ? AND m.author LIKE ?
  ORDER BY bm25(messages_fts) LIMIT ?
`);
const authorRecent = db.prepare(`
  SELECT id, author, body, created_at FROM messages
  WHERE channel_id = ? AND author LIKE ?
  ORDER BY created_at DESC LIMIT ?
`);
const around = db.prepare(`
  SELECT * FROM (
    SELECT id, author, body, created_at FROM messages
    WHERE channel_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?
  )
  UNION ALL
  SELECT * FROM (
    SELECT id, author, body, created_at FROM messages
    WHERE channel_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT ?
  )
  ORDER BY created_at
`);
const countStmt = db.prepare('SELECT COUNT(*) n, MIN(created_at) first FROM messages WHERE channel_id = ?');

function ftsQuery(text: string) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_']+/gu) ?? [];
  return [...new Set(words)]
    .filter((w) => w.length > 1)
    .slice(0, 12)
    .map((w) => `"${w.replace(/"/g, '')}"`)
    .join(' OR ');
}

/**
 * Search everything ever said in a channel. `query` is plain keywords, optionally with
 * `from:name` to filter by author. Returns hits with a bit of surrounding chat.
 */
export function searchArchive(channelId: string, query: string, skipAfter?: string) {
  const from = /from:(\S+)/i.exec(query)?.[1];
  const keywords = query.replace(/from:\S+/gi, '').trim();
  const authorLike = from ? `%${from.replace(/^@/, '')}%` : '%';
  const match = ftsQuery(keywords);

  let hits = (
    match
      ? ftsSearch.all(match, channelId, authorLike, cfg.searchHits * 3)
      : from
        ? authorRecent.all(channelId, authorLike, cfg.searchHits * 3)
        : []
  ) as unknown as Row[];

  // stuff already visible in the live transcript isn't worth repeating
  if (skipAfter) hits = hits.filter((h) => cmpId(h.id, skipAfter) < 0);
  hits = hits.slice(0, cfg.searchHits);

  const { n, first } = countStmt.get(channelId) as { n: number; first: number | null };
  const header = `searched ${n} archived messages${first ? ` going back to ${formatTime(first, true)} ${new Date(first).getFullYear()}` : ''}`;
  if (!hits.length) return `${header}\nno results for "${query}"`;

  const hitIds = new Set(hits.map((h) => h.id));
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const hit of hits.sort((a, b) => a.created_at - b.created_at)) {
    if (seen.has(hit.id)) continue;
    const ctx = around.all(
      channelId, hit.created_at, cfg.searchContext,
      channelId, hit.created_at, cfg.searchContext + 1
    ) as unknown as Row[];
    const lines = ctx
      .filter((r) => !seen.has(r.id))
      .map((r) => {
        seen.add(r.id);
        const mark = hitIds.has(r.id) ? '>> ' : '   ';
        return `${mark}[${formatTime(r.created_at, true)} ${new Date(r.created_at).getFullYear()}] ${r.author}: ${r.body.slice(0, 400)}`;
      });
    if (lines.length) blocks.push(lines.join('\n'));
  }
  return `${header}\n${blocks.join('\n...\n')}`.slice(0, cfg.searchChars);
}
