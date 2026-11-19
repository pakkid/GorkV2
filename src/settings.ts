import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Message, PartialMessage } from 'discord.js';
import { join } from 'node:path';
import { env } from './env';
import { logger } from './log';

const log = logger('settings');

export type ResponseMode = 'relevance' | 'ping' | 'ping+keyword' | 'none';
export type SafetyMode = 'unfiltered' | 'safe';
export type Scope = 'guild' | 'channel';

/** A switchable chunk of instructions for gork, written in the web ui. */
export interface Modifier {
  id: string;
  name: string;
  text: string;
  on: boolean;
}

/** What the owner told gork, for everywhere ('global') or one server. */
export interface Behavior {
  modifiers: Modifier[];
  instructions: string;
  // what gork likes and thinks, in the owner's words. shapes his takes, never quoted
  opinions: string;
}

interface Data {
  mode: Record<string, ResponseMode>;
  safety: Record<string, SafetyMode>;
  // channel id -> silenced until (epoch ms)
  silenced: Record<string, number>;
  // 'global' or a guild id
  behavior: Record<string, Behavior>;
  // people gork can't see or hear. 'global:<user id>' or 'guild:<guild id>:<user id>'
  ignored: Record<string, true>;
  // gork's memory starts here (epoch ms). 'global', 'guild:<id>' or 'channel:<id>'
  forgotten: Record<string, number>;
}

// starting points, all off; edit or delete them in the web ui
const presets: Modifier[] = [
  { id: 'meaner', name: 'Meaner', text: 'Be meaner than usual. Roast people harder, less mercy.', on: false },
  { id: 'softer', name: 'Softer', text: 'Be nicer than usual. Still sarcastic, but warmer and less cutting.', on: false },
  { id: 'yapper', name: 'Yapper', text: 'Chime in more often, even when nobody pinged you.', on: false },
  { id: 'lurker', name: 'Lurker', text: 'Talk a lot less. Unless someone pinged you, stay quiet almost always.', on: false },
  {
    id: 'helpful',
    name: 'Actually helpful',
    text: "Give correct answers to real questions. Keep the attitude, drop the wrong-answer bit.",
    on: false,
  },
];

const file = join(env.DATA_DIR, 'settings.json');
let data: Data = {
  mode: {},
  safety: {},
  silenced: {},
  behavior: { global: { modifiers: presets, instructions: '', opinions: '' } },
  ignored: {},
  forgotten: {},
};

try {
  data = { ...data, ...JSON.parse(readFileSync(file, 'utf8')) };
} catch {
  // first run
}

let saveTimer: NodeJS.Timeout | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(env.DATA_DIR, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      log.error('failed to save settings', error);
    }
  }, 200);
}

const key = (scope: Scope, id: string) => `${scope}:${id}`;

function resolve<T>(
  table: Record<string, T>,
  guildId: string | null | undefined,
  channelId: string,
  fallback: T,
  parentId?: string | null
): T {
  return (
    table[key('channel', channelId)] ??
    // threads follow their parent channel
    (parentId ? table[key('channel', parentId)] : undefined) ??
    (guildId ? table[key('guild', guildId)] : undefined) ??
    fallback
  );
}

export const settings = {
  // whitelist: every server channel starts off as 'none' until the owner turns it on
  mode(
    guildId: string | null | undefined,
    channelId: string,
    parentId?: string | null
  ): ResponseMode {
    return resolve(data.mode, guildId, channelId, 'none', parentId);
  },
  storedMode(scope: Scope, id: string): ResponseMode | undefined {
    return data.mode[key(scope, id)];
  },
  setMode(scope: Scope, id: string, mode: ResponseMode | null) {
    if (mode) data.mode[key(scope, id)] = mode;
    else delete data.mode[key(scope, id)];
    save();
  },

  safety(guildId: string | null | undefined, channelId: string): SafetyMode {
    return resolve(data.safety, guildId, channelId, 'unfiltered');
  },
  storedSafety(scope: Scope, id: string): SafetyMode | undefined {
    return data.safety[key(scope, id)];
  },
  setSafety(scope: Scope, id: string, mode: SafetyMode | null) {
    if (mode) data.safety[key(scope, id)] = mode;
    else delete data.safety[key(scope, id)];
    save();
  },

  isSilenced(channelId: string): boolean {
    const until = data.silenced[channelId];
    if (!until) return false;
    if (until > Date.now()) return true;
    delete data.silenced[channelId];
    save();
    return false;
  },
  silence(channelId: string, ms: number) {
    data.silenced[channelId] = Date.now() + ms;
    save();
  },
  unsilence(channelId: string) {
    if (!(channelId in data.silenced)) return;
    delete data.silenced[channelId];
    save();
  },

  behavior(scope: string): Behavior {
    const b = data.behavior[scope];
    return { modifiers: b?.modifiers ?? [], instructions: b?.instructions ?? '', opinions: b?.opinions ?? '' };
  },
  setBehavior(scope: string, behavior: Behavior) {
    if (!behavior.modifiers.length && !behavior.instructions && !behavior.opinions && scope !== 'global') {
      delete data.behavior[scope];
    } else {
      data.behavior[scope] = behavior;
    }
    save();
  },

  /** Whether gork ignores this person here. The owner can't be ignored. */
  isIgnored(guildId: string | null | undefined, userId: string): boolean {
    if (userId === env.DISCORD_OWNER_ID) return false;
    return !!data.ignored[`global:${userId}`] || (!!guildId && !!data.ignored[`guild:${guildId}:${userId}`]);
  },
  /** guildId null = everywhere. */
  setIgnored(guildId: string | null, userId: string, on: boolean) {
    const k = guildId ? `guild:${guildId}:${userId}` : `global:${userId}`;
    if (on) data.ignored[k] = true;
    else delete data.ignored[k];
    save();
  },
  /** Who's ignored in this server, and who's ignored everywhere. */
  ignoredIn(guildId: string | null) {
    const ids = (prefix: string) =>
      Object.keys(data.ignored)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    return { everywhere: ids('global:'), server: guildId ? ids(`guild:${guildId}:`) : [] };
  },

  /** Anything older than this (epoch ms) is wiped from gork's memory in that channel. */
  memoryStart(guildId: string | null | undefined, channelId: string): number {
    return Math.max(
      data.forgotten.global ?? 0,
      guildId ? (data.forgotten[`guild:${guildId}`] ?? 0) : 0,
      data.forgotten[`channel:${channelId}`] ?? 0
    );
  },
  /** id null = everywhere. */
  forget(scope: Scope | null, id: string | null, at = Date.now()) {
    data.forgotten[scope && id ? key(scope, id) : 'global'] = at;
    save();
  },
};

/** Everything the owner wants from gork here: global first, then the server's own. */
export function ownerRules(guildId: string | null) {
  const scopes = guildId ? [settings.behavior('global'), settings.behavior(guildId)] : [settings.behavior('global')];
  return {
    modifiers: scopes.flatMap((b) => b.modifiers.filter((m) => m.on && m.text.trim()).map((m) => m.text.trim())),
    instructions: scopes.map((b) => b.instructions.trim()).filter(Boolean),
    opinions: scopes.map((b) => b.opinions.trim()).filter(Boolean),
  };
}

/** Effective mode for a message: whitelisted server channels, and DMs only with the owner. */
export function modeOf(message: Message | PartialMessage): ResponseMode {
  const { channel } = message;
  if (!message.guildId) {
    const other = channel.isDMBased() && 'recipientId' in channel ? channel.recipientId : undefined;
    const owner = env.DISCORD_OWNER_ID;
    return owner && (message.author?.id === owner || other === owner) ? 'relevance' : 'none';
  }
  const parentId = channel.isThread() ? channel.parentId : null;
  return settings.mode(message.guildId, message.channelId, parentId);
}
