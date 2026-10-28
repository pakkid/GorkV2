import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { Client } from 'discord.js';
import { memory as cfg } from '../config';
import { env } from '../env';
import { logger } from '../log';
import { deleteNote, editNote, forgetAll, noteScopes, notes, remember } from '../memory';
import { summary } from '../stats';

const log = logger('web');
const page = readFileSync(new URL('./index.html', import.meta.url));

/** Private, loopback and link-local addresses. Anything else is the internet. */
export function isLan(address: string | undefined) {
  if (!address) return false;
  const ip = address.replace(/^::ffff:/i, '').toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (isIP(ip) === 6) return ip === '::1' || /^fe[89ab]/.test(ip) || /^f[cd]/.test(ip);
  return false;
}

/**
 * Only answer to names that point at a LAN box (an ip, localhost, a bare hostname or
 * a local suffix). Stops DNS rebinding: evil.com resolving to 192.168.1.5.
 */
export function isLocalHost(host: string | undefined) {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return (
    isIP(name) !== 0 ||
    name === 'localhost' ||
    !name.includes('.') ||
    /\.(local|lan|home\.arpa|internal|localhost)$/.test(name)
  );
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error('too big');
  }
  const data = JSON.parse(raw || '{}');
  return data && typeof data === 'object' ? data : {};
}

function scopeName(client: Client, id: string) {
  const guild = client.guilds.cache.get(id);
  if (guild) return guild.name;
  const channel = client.channels.cache.get(id);
  if (channel?.isDMBased() && 'recipient' in channel && channel.recipient) {
    return `DMs with @${channel.recipient.username}`;
  }
  return `unknown (${id})`;
}

function channelName(client: Client, id: string) {
  const ch = client.channels.cache.get(id);
  if (!ch) return { name: `unknown (${id})`, server: null };
  if (ch.isDMBased()) return { name: scopeName(client, id), server: null };
  return { name: `#${ch.name}`, server: ch.guild.name };
}

// the archive queries scan a lot of rows, so the page gets a slightly stale answer
const statsCache = new Map<string, { at: number; body: unknown }>();

function stats(client: Client, scope: string, days: number) {
  const key = `${scope}:${days}`;
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.body;
  const guild = scope === 'all' ? undefined : client.guilds.cache.get(scope);
  const data = summary(
    {
      since: Date.now() - days * 86_400_000,
      guildId: guild?.id,
      channelIds: guild ? [...guild.channels.cache.keys()] : undefined,
    },
    client.user?.id ?? '-'
  );
  const body = {
    ...data,
    days,
    topChannels: data.topChannels.map((c) => ({ ...c, ...channelName(client, c.id) })),
    servers: [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name })),
  };
  statsCache.set(key, { at: Date.now(), body });
  return body;
}

async function handle(client: Client, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    return res.end(page);
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  // writes need a header a cross-site form or fetch can't send without a preflight we never allow
  if (method !== 'GET' && req.headers['x-gork'] !== '1') return send(res, 403, { error: 'forbidden' });

  if (method === 'GET' && url.pathname === '/api/stats') {
    const scope = url.searchParams.get('scope') ?? 'all';
    if (scope !== 'all' && !/^\d+$/.test(scope)) return send(res, 400, { error: 'bad scope' });
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
    return send(res, 200, stats(client, scope, days));
  }

  if (method === 'GET' && url.pathname === '/api/scopes') {
    const counts = new Map(noteScopes().map((s) => [s.scope, s.n]));
    for (const id of client.guilds.cache.keys()) if (!counts.has(id)) counts.set(id, 0);
    const scopes = [...counts]
      .map(([id, count]) => ({ id, name: scopeName(client, id), count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return send(res, 200, { scopes, max: cfg.maxNotes, inPrompt: cfg.inPrompt });
  }

  if (url.pathname === '/api/notes') {
    const scope = method === 'GET' || method === 'DELETE' ? url.searchParams.get('scope') : null;
    if (method === 'GET') {
      if (!scope || !/^\d+$/.test(scope)) return send(res, 400, { error: 'bad scope' });
      return send(res, 200, { notes: notes(scope, cfg.maxNotes) });
    }
    if (method === 'DELETE') {
      if (!scope || !/^\d+$/.test(scope)) return send(res, 400, { error: 'bad scope' });
      const removed = forgetAll(scope);
      log.info(`wiped ${removed} notes in ${scope} from the web ui`);
      return send(res, 200, { removed });
    }
    if (method === 'POST') {
      const body = await readJson(req);
      if (typeof body.scope !== 'string' || !/^\d+$/.test(body.scope)) {
        return send(res, 400, { error: 'bad scope' });
      }
      if (typeof body.text !== 'string' || !body.text.trim()) return send(res, 400, { error: 'empty note' });
      if (!remember(body.scope, body.text)) return send(res, 409, { error: 'already remembered' });
      return send(res, 201, { ok: true });
    }
  }

  const one = /^\/api\/notes\/(\d+)$/.exec(url.pathname);
  if (one) {
    const id = Number(one[1]);
    if (method === 'PATCH') {
      const body = await readJson(req);
      if (typeof body.text !== 'string' || !editNote(id, body.text)) {
        return send(res, 400, { error: 'no such note or empty text' });
      }
      log.info(`edited note ${id} from the web ui`);
      return send(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      if (!deleteNote(id)) return send(res, 404, { error: 'no such note' });
      log.info(`deleted note ${id} from the web ui`);
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: 'not found' });
}

/** Stats page and memory editor on WEB_PORT, for devices on the local network only. */
export function startWeb(client: Client) {
  if (!env.WEB_PORT) return;
  const server = createServer((req, res) => {
    if (!isLan(req.socket.remoteAddress) || !isLocalHost(req.headers.host)) {
      log.warn(`refused ${req.socket.remoteAddress} (host: ${req.headers.host ?? '-'})`);
      res.writeHead(403).end();
      return;
    }
    handle(client, req, res).catch((error) => {
      log.warn(`${req.method} ${req.url} failed`, error);
      if (!res.headersSent) send(res, 400, { error: 'bad request' });
    });
  });
  server.on('error', (error) => log.error(`web ui couldn't start on port ${env.WEB_PORT}`, error));
  server.listen(env.WEB_PORT, () => log.info(`stats + memory editor on http://<this machine's lan ip>:${env.WEB_PORT}`));
}
