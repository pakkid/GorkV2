import { db } from './archive';
import { systemPrompt } from './ai/prompt';
import { history, prices, timezone } from './config';
import { env } from './env';
import { logger } from './log';

const log = logger('stats');

db.exec(`
  -- one row per model call
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    guild_id TEXT,
    channel_id TEXT,
    model TEXT NOT NULL,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cached INTEGER NOT NULL DEFAULT 0,
    reasoning INTEGER NOT NULL DEFAULT 0,
    cost REAL,
    ms INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 1,
    -- 1 when the provider didn't report usage and the tokens were guessed from text length
    estimated INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS usage_at ON usage (at);

  -- one row per discord message gork sent
  CREATE TABLE IF NOT EXISTS sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    guild_id TEXT,
    channel_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    -- 1 = reconstructed from the archive, from before tracking existed
    backfill INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS sent_at ON sent (at);

  -- one row per time gork thought about a channel, and whether he talked
  CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    guild_id TEXT,
    channel_id TEXT NOT NULL,
    pinged INTEGER NOT NULL,
    spoke INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS turns_at ON turns (at);
`);

export interface Where {
  kind: 'chat' | 'notes';
  guildId?: string | null;
  channelId?: string | null;
}

export interface Usage {
  model: string;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  // what the provider says it charged, if it says
  cost?: number;
  ms: number;
  ok: boolean;
  estimated: boolean;
}

// AI_PRICES=model=in/out,... in $ per million tokens, on top of config.prices
const priceTable = new Map<string, [number, number]>(Object.entries(prices));
for (const entry of (env.AI_PRICES ?? '').split(',')) {
  const m = /^\s*([^=]+?)\s*=\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(entry);
  if (m) priceTable.set(m[1]!, [Number(m[2]), Number(m[3])]);
}

/** Provider-reported cost when there is one, else an estimate from the price table. */
function costOf(u: Usage) {
  if (u.cost != null) return u.cost;
  const price = priceTable.get(u.model);
  if (!price) return null;
  return ((u.input - u.cached) * price[0] + u.cached * price[0] * 0.25 + u.output * price[1]) / 1e6;
}

const insertUsage = db.prepare(`
  INSERT INTO usage (at, kind, guild_id, channel_id, model, input, output, cached, reasoning, cost, ms, ok, estimated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertSent = db.prepare('INSERT INTO sent (at, guild_id, channel_id, kind) VALUES (?, ?, ?, ?)');
const insertTurn = db.prepare(
  'INSERT INTO turns (at, guild_id, channel_id, pinged, spoke) VALUES (?, ?, ?, ?, ?)'
);

// stats are nice to have; a failed write must never break gork
function safely(fn: () => void) {
  try {
    fn();
  } catch (error) {
    log.warn('stats write failed', error);
  }
}

export function recordUsage(where: Where, u: Usage) {
  safely(() =>
    insertUsage.run(
      Date.now(), where.kind, where.guildId ?? null, where.channelId ?? null, u.model,
      u.input, u.output, u.cached, u.reasoning, costOf(u), u.ms, u.ok ? 1 : 0, u.estimated ? 1 : 0
    )
  );
}

export function recordSent(guildId: string | null, channelId: string, kind: string) {
  safely(() => insertSent.run(Date.now(), guildId, channelId, kind));
}

// ---------------------------------------------------------------------------
// estimating the past: gork's own messages are in the archive, so the turns where he
// talked can be rebuilt from them. calls where he stayed quiet left no trace and aren't counted

const liveStart = db.prepare(`SELECT MIN(at) t FROM usage WHERE kind != 'history'`);
const sentStart = db.prepare('SELECT MIN(at) t FROM sent WHERE backfill = 0');
const clearHistory = db.prepare(`DELETE FROM usage WHERE kind = 'history'`);
const clearSent = db.prepare('DELETE FROM sent WHERE backfill = 1');
const gorkMessages = db.prepare(`
  SELECT channel_id, length(body) len, created_at, reply_to FROM messages
  WHERE author_id = ? AND created_at < ? ORDER BY channel_id, created_at
`);
const contextBefore = db.prepare(`
  SELECT SUM(len) chars FROM (
    SELECT length(body) + 80 len FROM messages
    WHERE channel_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?
  )
`);
const insertBackfillSent = db.prepare(
  'INSERT INTO sent (at, guild_id, channel_id, kind, backfill) VALUES (?, ?, ?, ?, 1)'
);

/**
 * Rebuild estimated usage for everything gork said before tracking started. Safe to rerun:
 * it replaces its own previous estimate (the archive keeps filling in as it crawls).
 */
export function backfillHistory(selfId: string, guildOf: (channelId: string) => string | null) {
  const started = Date.now();
  const cutoff = Math.min(
    num((liveStart.get() as { t: unknown }).t) || Date.now(),
    num((sentStart.get() as { t: unknown }).t) || Date.now()
  );
  const rows = gorkMessages.all(selfId, cutoff) as {
    channel_id: string;
    len: number;
    created_at: number;
    reply_to: string | null;
  }[];
  const system = systemPrompt(false).length;
  const model = env.AI_MODEL;
  let turns = 0;
  let cost = 0;

  db.exec('BEGIN');
  try {
    clearHistory.run();
    clearSent.run();
    // messages from one turn go out a few seconds apart; a longer gap is a new turn
    let turn: { channel: string; at: number; last: number; out: number } | undefined;
    const flush = () => {
      if (!turn) return;
      const context = Math.min(
        num((contextBefore.get(turn.channel, turn.at, history.contextMessages) as { chars: unknown }).chars),
        history.contextChars
      );
      const u: Usage = {
        model,
        // + roughly what the member list, notes and the notes around the transcript add
        input: Math.ceil((system + context + 1500) / 4),
        output: Math.ceil(turn.out / 4),
        cached: 0,
        reasoning: 0,
        ms: 0,
        ok: true,
        estimated: true,
      };
      const c = costOf(u);
      cost += c ?? 0;
      turns++;
      insertUsage.run(
        turn.at, 'history', guildOf(turn.channel), turn.channel, model,
        u.input, u.output, 0, 0, c, 0, 1, 1
      );
    };
    for (const m of rows) {
      if (!turn || turn.channel !== m.channel_id || m.created_at - turn.last > 20_000) {
        flush();
        turn = { channel: m.channel_id, at: m.created_at, last: m.created_at, out: 30 };
      }
      turn.last = m.created_at;
      // the message plus its json wrapping
      turn.out += m.len + 45;
      insertBackfillSent.run(m.created_at, guildOf(m.channel_id), m.channel_id, m.reply_to ? 'reply' : 'send');
    }
    flush();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    log.warn('history backfill failed', error);
    return;
  }
  log.info(
    `estimated ${turns} past turns from ${rows.length} archived messages (~$${cost.toFixed(4)}, ${Date.now() - started}ms)`
  );
}

export function recordTurn(guildId: string | null, channelId: string, pinged: boolean, spoke: boolean) {
  safely(() => insertTurn.run(Date.now(), guildId, channelId, pinged ? 1 : 0, spoke ? 1 : 0));
}

// ---------------------------------------------------------------------------
// reading it back, for the web ui

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });

interface Range {
  since: number;
  guildId?: string;
  // channels of that server, for the archive (which doesn't know about servers)
  channelIds?: string[];
}

function filter(r: Range, guildCol: string) {
  return r.guildId
    ? { sql: ` AND ${guildCol} = ?`, args: [r.guildId] }
    : { sql: '', args: [] as string[] };
}

function channelFilter(r: Range) {
  if (!r.guildId) return { sql: '', args: [] as string[] };
  const ids = r.channelIds?.length ? r.channelIds : ['-'];
  return { sql: ` AND channel_id IN (${ids.map(() => '?').join(',')})`, args: ids };
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

/** Everything the stats page shows, for one server (or all) since a point in time. */
export function summary(r: Range, selfId: string) {
  const g = filter(r, 'guild_id');
  const c = channelFilter(r);

  const totals = db
    .prepare(`
      SELECT COUNT(*) calls, SUM(input) input, SUM(output) output, SUM(cached) cached,
        SUM(reasoning) reasoning, SUM(cost) cost, SUM(cost IS NULL) uncosted,
        SUM(ok = 0) failed, AVG(CASE WHEN ok AND kind != 'history' THEN ms END) ms, SUM(estimated) estimated,
        SUM(kind = 'history') historyCalls, SUM(CASE WHEN kind = 'history' THEN cost END) historyCost
      FROM usage WHERE at >= ?${g.sql}`)
    .get(r.since, ...g.args) as Record<string, unknown>;

  const lifetime = db
    .prepare(`SELECT SUM(input + output) tokens, SUM(cost) cost FROM usage WHERE 1${g.sql}`)
    .get(...g.args) as Record<string, unknown>;

  const models = (
    db
      .prepare(`
        SELECT model, kind, COUNT(*) calls, SUM(input) input, SUM(output) output, SUM(cost) cost,
          SUM(cost IS NULL) uncosted, AVG(CASE WHEN ok AND ms > 0 THEN ms END) ms, SUM(ok = 0) failed
        FROM usage WHERE at >= ?${g.sql} GROUP BY model, kind ORDER BY calls DESC`)
      .all(r.since, ...g.args) as Record<string, unknown>[]
  ).map((m) => ({
    model: String(m.model),
    kind: String(m.kind),
    calls: num(m.calls),
    input: num(m.input),
    output: num(m.output),
    cost: num(m.cost),
    uncosted: num(m.uncosted),
    ms: Math.round(num(m.ms)),
    failed: num(m.failed),
  }));

  const sent = db
    .prepare(`
      SELECT COUNT(*) n, SUM(kind = 'reply') replies FROM sent WHERE at >= ?${g.sql}`)
    .get(r.since, ...g.args) as Record<string, unknown>;

  const turns = db
    .prepare(`
      SELECT COUNT(*) n, SUM(spoke) spoke, SUM(pinged) pinged FROM turns WHERE at >= ?${g.sql}`)
    .get(r.since, ...g.args) as Record<string, unknown>;

  // hourly in sql, then into local days here so day edges follow gork's timezone
  const days = new Map<string, { input: number; output: number; cost: number; sent: number }>();
  for (let t = r.since; t <= Date.now(); t += 86_400_000) {
    days.set(dayFmt.format(t), { input: 0, output: 0, cost: 0, sent: 0 });
  }
  days.set(dayFmt.format(Date.now()), days.get(dayFmt.format(Date.now())) ?? { input: 0, output: 0, cost: 0, sent: 0 });
  const bucket = (hour: number) => days.get(dayFmt.format(hour * 3_600_000));
  for (const row of db
    .prepare(`
      SELECT at / 3600000 hour, SUM(input) input, SUM(output) output, SUM(cost) cost
      FROM usage WHERE at >= ?${g.sql} GROUP BY hour`)
    .all(r.since, ...g.args) as Record<string, unknown>[]) {
    const d = bucket(num(row.hour));
    if (!d) continue;
    d.input += num(row.input);
    d.output += num(row.output);
    d.cost += num(row.cost);
  }
  for (const row of db
    .prepare(`SELECT at / 3600000 hour, COUNT(*) n FROM sent WHERE at >= ?${g.sql} GROUP BY hour`)
    .all(r.since, ...g.args) as Record<string, unknown>[]) {
    const d = bucket(num(row.hour));
    if (d) d.sent += num(row.n);
  }

  const topChatters = (
    db
      .prepare(`
        SELECT author_id, author, MAX(created_at) last, COUNT(*) n FROM messages
        WHERE created_at >= ? AND author_id != ?${c.sql}
        GROUP BY author_id ORDER BY n DESC LIMIT 10`)
      .all(r.since, selfId, ...c.args) as Record<string, unknown>[]
  ).map((row) => ({ id: String(row.author_id), name: String(row.author), count: num(row.n) }));

  const topChannels = (
    db
      .prepare(`
        SELECT channel_id, COUNT(*) n, SUM(author_id = ?) gork FROM messages
        WHERE created_at >= ?${c.sql}
        GROUP BY channel_id ORDER BY n DESC LIMIT 10`)
      .all(selfId, r.since, ...c.args) as Record<string, unknown>[]
  ).map((row) => ({ id: String(row.channel_id), count: num(row.n), gork: num(row.gork) }));

  const seen = db
    .prepare(`SELECT COUNT(*) n, SUM(author_id = ?) gork FROM messages WHERE created_at >= ?${c.sql}`)
    .get(selfId, r.since, ...c.args) as Record<string, unknown>;

  return {
    totals: {
      calls: num(totals.calls),
      input: num(totals.input),
      output: num(totals.output),
      cached: num(totals.cached),
      reasoning: num(totals.reasoning),
      cost: num(totals.cost),
      uncosted: num(totals.uncosted),
      failed: num(totals.failed),
      estimated: num(totals.estimated),
      historyCalls: num(totals.historyCalls),
      historyCost: num(totals.historyCost),
      ms: Math.round(num(totals.ms)),
      sent: num(sent.n),
      replies: num(sent.replies),
      turns: num(turns.n),
      spoke: num(turns.spoke),
      pinged: num(turns.pinged),
      seen: num(seen.n),
      gorkArchived: num(seen.gork),
    },
    lifetime: { tokens: num(lifetime.tokens), cost: num(lifetime.cost) },
    daily: [...days].map(([day, d]) => ({ day, ...d })),
    models,
    topChatters,
    topChannels,
  };
}
