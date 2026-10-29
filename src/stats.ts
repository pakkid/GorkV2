import { prices, timezone } from './config';
import { db } from './db';
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
    -- 1 = reconstructed from the old message archive, from before tracking existed
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
  kind: 'chat';
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

export function recordTurn(guildId: string | null, channelId: string, pinged: boolean, spoke: boolean) {
  safely(() => insertTurn.run(Date.now(), guildId, channelId, pinged ? 1 : 0, spoke ? 1 : 0));
}

// ---------------------------------------------------------------------------
// reading it back, for the web ui

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });

interface Range {
  since: number;
  guildId?: string;
}

function filter(r: Range, guildCol: string) {
  return r.guildId
    ? { sql: ` AND ${guildCol} = ?`, args: [r.guildId] }
    : { sql: '', args: [] as string[] };
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

/** Everything the stats page shows, for one server (or all) since a point in time. */
export function summary(r: Range) {
  const g = filter(r, 'guild_id');

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

  const topChannels = (
    db
      .prepare(`
        SELECT channel_id, COUNT(*) n FROM sent
        WHERE at >= ?${g.sql}
        GROUP BY channel_id ORDER BY n DESC LIMIT 10`)
      .all(r.since, ...g.args) as Record<string, unknown>[]
  ).map((row) => ({ id: String(row.channel_id), count: num(row.n) }));

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
    },
    lifetime: { tokens: num(lifetime.tokens), cost: num(lifetime.cost) },
    daily: [...days].map(([day, d]) => ({ day, ...d })),
    models,
    topChannels,
  };
}
