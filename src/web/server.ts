import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { Client } from 'discord.js';
import { env } from '../env';
import { logger } from '../log';
import { systemPrompt } from '../ai/prompt';
import { type Behavior, type Modifier, ownerRules, settings } from '../settings';
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
    if (raw.length > 200_000) throw new Error('too big');
  }
  const data = JSON.parse(raw || '{}');
  return data && typeof data === 'object' ? data : {};
}

function channelName(client: Client, id: string) {
  const ch = client.channels.cache.get(id);
  if (!ch) return { name: `unknown (${id})`, server: null };
  if (ch.isDMBased()) {
    const who = 'recipient' in ch && ch.recipient ? `@${ch.recipient.username}` : 'someone';
    return { name: `DMs with ${who}`, server: null };
  }
  return { name: `#${ch.name}`, server: ch.guild.name };
}

// the page polls; no need to rerun every query each time
const statsCache = new Map<string, { at: number; body: unknown }>();

function stats(client: Client, scope: string, days: number) {
  const key = `${scope}:${days}`;
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.body;
  const guild = scope === 'all' ? undefined : client.guilds.cache.get(scope);
  const data = summary({ since: Date.now() - days * 86_400_000, guildId: guild?.id });
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

  if (url.pathname === '/api/behavior') {
    const scope = url.searchParams.get('scope') ?? 'global';
    if (scope !== 'global' && !client.guilds.cache.has(scope)) return send(res, 400, { error: 'bad scope' });
    if (method === 'GET') {
      const scopes = [
        { id: 'global', name: 'Everywhere' },
        ...[...client.guilds.cache.values()]
          .map((g) => ({ id: g.id, name: g.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ];
      return send(res, 200, { scopes, behavior: settings.behavior(scope) });
    }
    if (method === 'PUT') {
      const behavior = parseBehavior(await readJson(req));
      if (!behavior) return send(res, 400, { error: 'bad behaviour' });
      settings.setBehavior(scope, behavior);
      log.info(`behaviour for ${scope} changed from the web ui`);
      return send(res, 200, { behavior });
    }
  }

  // the system prompt gork gets in that scope, so the owner can see their rules land
  if (method === 'GET' && url.pathname === '/api/prompt') {
    const scope = url.searchParams.get('scope') ?? 'global';
    const guild = client.guilds.cache.get(scope);
    const safe = guild ? settings.safety(guild.id, '') === 'safe' : false;
    return send(res, 200, { prompt: systemPrompt(safe, ownerRules(guild?.id ?? null)) });
  }

  return send(res, 404, { error: 'not found' });
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

function parseBehavior(body: Record<string, unknown>): Behavior | undefined {
  if (!Array.isArray(body.modifiers) || body.modifiers.length > 50) return;
  const modifiers: Modifier[] = [];
  for (const raw of body.modifiers as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') return;
    const id = str(raw.id, 40) || Math.random().toString(36).slice(2, 10);
    modifiers.push({ id, name: str(raw.name, 60), text: str(raw.text, 2000), on: raw.on === true });
  }
  return { modifiers, instructions: str(body.instructions, 8000) };
}

/** Stats page and behaviour editor on WEB_PORT, for devices on the local network only. */
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
  server.listen(env.WEB_PORT, () => log.info(`stats + behaviour editor on http://<this machine's lan ip>:${env.WEB_PORT}`));
}
