import { readFileSync } from 'node:fs';
import { arch } from 'node:os';
import { join } from 'node:path';
import { timezone } from './config';
import { db } from './db';
import { env } from './env';
import { logger } from './log';

const log = logger('tokenmaxxing');

// the CLI syncs every 5 minutes; gork's numbers don't move that fast
const everyMs = 10 * 60 * 1000;

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });

interface ModelDay {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
}

/**
 * Every day gork has used a model, in the shape `ccusage daily --breakdown` prints.
 * Whole history every time: the server replaces each day it's sent, so a resend is free.
 */
function dailyReport() {
  const days = new Map<string, Map<string, ModelDay>>();
  // hourly in sql, then into local days here so day edges follow gork's timezone.
  // failed calls are left out: their tokens are guessed and nobody billed them
  const rows = db
    .prepare(`
      SELECT at / 3600000 hour, model, SUM(input) input, SUM(output) output, SUM(cached) cached,
        SUM(cost) cost
      FROM usage WHERE ok = 1 GROUP BY hour, model`)
    .all() as { hour: number; model: string; input: number; output: number; cached: number; cost: number | null }[];

  for (const row of rows) {
    const day = dayFmt.format(row.hour * 3_600_000);
    const models = days.get(day) ?? new Map<string, ModelDay>();
    days.set(day, models);
    const m = models.get(row.model) ?? {
      modelName: row.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cost: 0,
    };
    models.set(row.model, m);
    // gork's input counts cached tokens too; ccusage keeps them apart
    m.inputTokens += Math.max(0, row.input - row.cached);
    m.cacheReadTokens += row.cached;
    m.outputTokens += row.output;
    m.cost += row.cost ?? 0;
  }

  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, models]) => {
    const modelBreakdowns = [...models.values()];
    const sum = (k: keyof Omit<ModelDay, 'modelName'>) => modelBreakdowns.reduce((n, m) => n + m[k], 0);
    const inputTokens = sum('inputTokens');
    const outputTokens = sum('outputTokens');
    const cacheReadTokens = sum('cacheReadTokens');
    return {
      date,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      totalTokens: inputTokens + outputTokens + cacheReadTokens,
      totalCost: sum('cost'),
      modelsUsed: modelBreakdowns.map((m) => m.modelName),
      modelBreakdowns,
    };
  });
}

// where `TOKENMAXXING_CONFIG_DIR=/app/data/tokenmaxxing tokenmaxxing login` saves its token
const configFile = join(env.DATA_DIR, 'tokenmaxxing', 'config.json');

/** The env token, else whatever `tokenmaxxing login` last saved in the data dir. */
function currentToken() {
  if (env.TOKENMAXXING_API_TOKEN) return env.TOKENMAXXING_API_TOKEN;
  try {
    const { token } = JSON.parse(readFileSync(configFile, 'utf8')) as { token?: unknown };
    return typeof token === 'string' && token ? token : undefined;
  } catch {
    return undefined;
  }
}

// a revoked or mistyped token won't fix itself, but a fresh login will
let rejected: string | undefined;
let announced = false;

async function sync() {
  const token = currentToken();
  if (!token || token === rejected) return;
  if (!announced) {
    announced = true;
    log.info(`syncing usage to tokenmaxxing.sh as ${env.TOKENMAXXING_SOURCE}`);
  }
  const daily = dailyReport();
  if (!daily.length) return;
  const res = await fetch(`${env.TOKENMAXXING_API_URL.replace(/\/$/, '')}/usage/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      device: { name: 'gork', platform: process.platform, arch: arch() },
      reports: [
        {
          command: ['gork', env.TOKENMAXXING_SOURCE, 'daily'],
          payload: { daily },
          reportKind: 'daily',
          source: env.TOKENMAXXING_SOURCE,
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) {
    rejected = token;
    announced = false;
    log.warn('token rejected, not syncing until there is a new one. make one with `tokenmaxxing login`');
    return;
  }
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  log.debug(`synced ${daily.length} days`);
}

/**
 * Pushes gork's token usage to his tokenmaxxing.sh profile whenever there's a token for it.
 * The token is looked up on every run, so logging in from the container's shell needs no restart.
 */
export function startTokenmaxxing() {
  const run = () => void sync().catch((error) => log.warn('sync failed', error));
  run();
  setInterval(run, everyMs).unref();
}
