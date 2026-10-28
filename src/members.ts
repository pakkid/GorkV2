import type { Guild } from 'discord.js';
import { members as cfg } from './config';
import { type ChannelLog, whoIs } from './history';
import { logger } from './log';

const log = logger('members');

/** Pull the whole member list into the cache (needs the Server Members intent). */
export async function loadMembers(guild: Guild) {
  if (guild.memberCount > cfg.fetchMax) {
    log.info(`${guild.name} has ${guild.memberCount} members, only using cached ones`);
    return;
  }
  try {
    const started = Date.now();
    const fetched = await guild.members.fetch();
    log.info(`loaded ${fetched.size} members of ${guild.name} (${Date.now() - started}ms)`);
  } catch (error) {
    log.warn(`couldn't load members of ${guild.name}`, error);
  }
}

/**
 * Who's in the server, with the ids gork needs to actually ping people.
 * People who've been talking in the channel come first.
 */
export function roster(guild: Guild, chLog: ChannelLog) {
  const selfId = guild.client.user.id;
  const active = new Map<string, number>();
  chLog.messages.forEach((m, i) => active.set(m.authorId, i));
  const all = [...guild.members.cache.values()]
    .filter((m) => m.id !== selfId)
    .sort(
      (a, b) =>
        (active.get(b.id) ?? -1) - (active.get(a.id) ?? -1) ||
        a.displayName.localeCompare(b.displayName)
    );
  const lines = all.slice(0, cfg.roster).map((m) => {
    let line = whoIs({
      name: m.displayName,
      globalName: m.user.globalName ?? undefined,
      username: m.user.username,
    });
    line += ` <@${m.id}>`;
    if (m.user.bot) line += ' ⟦bot⟧';
    return line;
  });
  const total = Math.max(guild.memberCount, all.length + 1);
  const more = total - 1 - lines.length;
  return { text: lines.join('\n') + (more > 0 ? `\n…and ${more} more` : ''), total };
}

/**
 * Every name gork might write after an @ (display name, username, global name)
 * mapped to the person's id, from the server's members plus anyone in the channel log.
 */
export function mentionNames(guild: Guild | null, chLog: ChannelLog) {
  const ids = new Map<string, string>();
  const selfId = guild?.client.user.id;
  for (const m of guild?.members.cache.values() ?? []) {
    if (m.id === selfId) continue;
    for (const n of [m.user.username, m.user.globalName, m.displayName]) {
      if (n) ids.set(n.toLowerCase(), m.id);
    }
  }
  // people in the channel win ties, they're who gork means
  for (const m of chLog.messages) {
    if (m.self) continue;
    ids.set(m.username.toLowerCase(), m.authorId);
    ids.set(m.name.toLowerCase(), m.authorId);
  }
  return ids;
}
