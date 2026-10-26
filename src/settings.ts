import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { Message, PartialMessage } from 'discord.js';
import { join } from 'node:path';
import { env } from './env';
import { logger } from './log';

const log = logger('settings');

export type ResponseMode = 'relevance' | 'ping' | 'ping+keyword' | 'none';
export type SafetyMode = 'unfiltered' | 'safe';
export type Scope = 'guild' | 'channel';

interface Data {
  mode: Record<string, ResponseMode>;
  safety: Record<string, SafetyMode>;
  // channel id -> silenced until (epoch ms)
  silenced: Record<string, number>;
}

const file = join(env.DATA_DIR, 'settings.json');
let data: Data = { mode: {}, safety: {}, silenced: {} };

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
};

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
