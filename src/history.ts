import {
  type Message,
  MessageType,
  type PartialMessage,
  type TextBasedChannel,
} from 'discord.js';
import { archiveMessage, archiveRecent, unarchive } from './archive';
import { history as cfg, timezone } from './config';
import { logger } from './log';

const log = logger('history');

export interface ChatMsg {
  id: string;
  authorId: string;
  name: string;
  username: string;
  bot: boolean;
  self: boolean;
  content: string;
  replyToId?: string;
  // fallback for when the replied-to message isn't in the buffer
  replySnippet?: string;
  attachments: { name: string; url: string; type: string }[];
  extras: string[];
  reactions: Map<string, number>;
  mentionsSelf: boolean;
  createdAt: number;
  edited: boolean;
  deleted: boolean;
}

/** Compare discord snowflakes without BigInt. */
export function cmpId(a: string, b: string) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function clip(s: string, n: number) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

function emojiKey(e: { id: string | null; name: string | null }) {
  return e.id ? `:${e.name}:` : (e.name ?? '?');
}

function resolveContent(message: Message, text: string) {
  const { mentions, guild, client } = message;
  return text
    .replace(/<@!?(\d+)>/g, (_, id: string) => {
      const member = mentions.members?.get(id) ?? guild?.members.cache.get(id);
      const user = mentions.users.get(id) ?? client.users.cache.get(id);
      const name = member?.displayName ?? user?.displayName;
      return name ? `@${name}` : '@someone';
    })
    .replace(/<@&(\d+)>/g, (_, id: string) => {
      const role = mentions.roles.get(id) ?? guild?.roles.cache.get(id);
      return `@${role?.name ?? 'role'}`;
    })
    .replace(/<#(\d+)>/g, (_, id: string) => {
      const ch = client.channels.cache.get(id);
      return `#${ch && 'name' in ch && ch.name ? ch.name : 'channel'}`;
    })
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(?::\w)?>/g, (_, s: string) =>
      formatTime(Number(s) * 1000, true)
    );
}

export function toChatMsg(message: Message): ChatMsg {
  const selfId = message.client.user.id;
  const extras: string[] = [];

  if (message.type === MessageType.UserJoin) extras.push('joined the server');
  for (const embed of message.embeds) {
    const text = [embed.title, embed.description].filter(Boolean).join(' — ');
    if (text) extras.push(`embed: ${clip(text, 200)}`);
  }
  for (const sticker of message.stickers.values()) {
    extras.push(`sticker: ${sticker.name}`);
  }
  if (message.poll) {
    const answers = message.poll.answers.map((a) => a.text).join(' / ');
    extras.push(`poll: ${message.poll.question.text} (${answers})`);
  }
  for (const snap of message.messageSnapshots?.values() ?? []) {
    if (snap.content) extras.push(`forwarded: ${clip(snap.content, 500)}`);
  }

  let replyToId: string | undefined;
  let replySnippet: string | undefined;
  if (message.type === MessageType.Reply && message.reference?.messageId) {
    replyToId = message.reference.messageId;
    // discord.js caches the referenced_message from the gateway payload
    const ref = message.channel.messages.cache.get(replyToId);
    if (ref) {
      const who = ref.member?.displayName ?? ref.author.displayName;
      replySnippet = `${who}: ${clip(ref.content || '[attachment]', 80)}`;
    }
  }

  const reactions = new Map<string, number>();
  for (const r of message.reactions.cache.values()) {
    reactions.set(emojiKey(r.emoji), r.count);
  }

  return {
    id: message.id,
    authorId: message.author.id,
    name:
      message.author.id === selfId
        ? 'gork'
        : (message.member?.displayName ?? message.author.displayName),
    username: message.author.username,
    bot: message.author.bot,
    self: message.author.id === selfId,
    content: resolveContent(message, message.content),
    replyToId,
    replySnippet,
    attachments: [...message.attachments.values()].map((a) => ({
      name: a.name,
      url: a.url,
      type: a.contentType ?? 'unknown',
    })),
    extras,
    reactions,
    mentionsSelf:
      message.mentions.users.has(selfId) ||
      (message.mentions.repliedUser?.id === selfId && !!replyToId),
    createdAt: message.createdTimestamp,
    edited: !!message.editedTimestamp,
    deleted: false,
  };
}

export class ChannelLog {
  messages: ChatMsg[] = [];
  byId = new Map<string, ChatMsg>();
  // id of the newest message gork has already thought about
  lastSeenId?: string;
  private backfilled?: Promise<void>;

  add(msg: ChatMsg) {
    const existing = this.byId.get(msg.id);
    if (existing) {
      Object.assign(existing, msg);
      return;
    }
    this.byId.set(msg.id, msg);
    const last = this.messages.at(-1);
    if (!last || cmpId(last.id, msg.id) < 0) {
      this.messages.push(msg);
    } else {
      this.messages.push(msg);
      this.messages.sort((a, b) => cmpId(a.id, b.id));
    }
    while (this.messages.length > cfg.maxMessages) {
      const dropped = this.messages.shift();
      if (dropped) this.byId.delete(dropped.id);
    }
  }

  /** Pull recent history from discord once, so gork isn't blind after a restart. */
  backfill(channel: TextBasedChannel): Promise<void> {
    this.backfilled ??= (async () => {
      const started = Date.now();
      const fetched = await channel.messages.fetch({ limit: cfg.backfill });
      const msgs = [...fetched.values()]
        .filter((m) => !m.content.startsWith('//'))
        .sort((a, b) => cmpId(a.id, b.id))
        .map(toChatMsg);
      for (const m of msgs) if (!this.byId.has(m.id)) this.add(m);
      archiveRecent(channel, msgs);
      log.debug(
        `backfilled ${fetched.size} msgs in ${channel.id} (${Date.now() - started}ms)`
      );
    })().catch((error) => {
      log.warn(`backfill failed in ${channel.id}`, error);
      this.backfilled = undefined;
    });
    return this.backfilled;
  }
}

const channels = new Map<string, ChannelLog>();

export function channelLog(channelId: string): ChannelLog {
  let entry = channels.get(channelId);
  if (entry) {
    // refresh LRU position
    channels.delete(channelId);
  } else {
    entry = new ChannelLog();
  }
  channels.set(channelId, entry);
  if (channels.size > cfg.maxChannels) {
    const oldest = channels.keys().next().value;
    if (oldest) channels.delete(oldest);
  }
  return entry;
}

export function peekLog(channelId: string) {
  return channels.get(channelId);
}

export function recordMessage(message: Message): ChatMsg | undefined {
  if (message.content.startsWith('//')) return;
  const msg = toChatMsg(message);
  channelLog(message.channelId).add(msg);
  archiveMessage(message.channelId, msg);
  return msg;
}

export function recordEdit(message: Message | PartialMessage) {
  if (message.partial) return;
  if (message.content.startsWith('//')) {
    recordDelete(message.channelId, message.id);
    return;
  }
  const msg = toChatMsg(message);
  archiveMessage(message.channelId, msg);
  const log = peekLog(message.channelId);
  if (log?.byId.has(message.id)) log.add(msg);
}

export function recordDelete(channelId: string, id: string) {
  const msg = peekLog(channelId)?.byId.get(id);
  if (msg) msg.deleted = true;
  // deleted means deleted, gork forgets it too
  unarchive(id);
}

export function recordReaction(
  channelId: string,
  messageId: string,
  emoji: { id: string | null; name: string | null },
  count: number | null
) {
  const msg = peekLog(channelId)?.byId.get(messageId);
  if (!msg) return;
  const key = emojiKey(emoji);
  if (count && count > 0) msg.reactions.set(key, count);
  else msg.reactions.delete(key);
}

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: timezone,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: timezone,
  month: 'short',
  day: 'numeric',
});

export function formatTime(ms: number, withDate = false) {
  const t = timeFmt.format(ms);
  return withDate ? `${dateFmt.format(ms)} ${t}` : t;
}

export interface Transcript {
  text: string;
  // transcript number -> discord message id
  refs: Map<number, string>;
  images: { url: string; ref: number }[];
  newCount: number;
  lastId?: string;
}

/**
 * Render the channel as a numbered transcript the model can read top to bottom.
 * Messages after `lastSeenId` are marked as new so gork knows what he hasn't reacted to yet.
 */
export function renderTranscript(
  log: ChannelLog,
  interruptedBy: ReadonlySet<string> = new Set()
): Transcript {
  const visible = log.messages.filter((m) => !m.deleted);
  const window: ChatMsg[] = [];
  let chars = 0;
  for (let i = visible.length - 1; i >= 0; i--) {
    const m = visible[i]!;
    chars += m.content.length + 60;
    if (window.length >= cfg.contextMessages || chars > cfg.contextChars) break;
    window.unshift(m);
  }

  const refs = new Map<number, string>();
  const refOf = new Map<string, number>();
  window.forEach((m, i) => {
    refs.set(i + 1, m.id);
    refOf.set(m.id, i + 1);
  });

  const lines: string[] = [];
  const images: Transcript['images'] = [];
  let newCount = 0;
  let markedNew = false;
  let lastDay = '';

  for (const [i, m] of window.entries()) {
    const ref = i + 1;
    const isNew = !log.lastSeenId || cmpId(m.id, log.lastSeenId) > 0;
    if (isNew && log.lastSeenId && !markedNew) {
      lines.push('', '--- new since you last spoke/looked ---');
      markedNew = true;
    }
    if (isNew && !m.self) newCount++;

    const day = dateFmt.format(m.createdAt);
    if (day !== lastDay) {
      lines.push(`(${day})`);
      lastDay = day;
    }

    let who: string;
    if (m.self) who = 'gork (you)';
    else {
      who = m.name;
      if (m.username.toLowerCase() !== m.name.toLowerCase()) who += ` (@${m.username})`;
      if (m.bot) who += ' [bot]';
    }

    let head = `[#${ref} ${formatTime(m.createdAt)}] ${who}`;
    if (m.replyToId) {
      const target = refOf.get(m.replyToId);
      if (target) {
        const t = log.byId.get(m.replyToId);
        head += ` ↪ #${target}${t ? ` ${t.self ? 'gork (you)' : t.name}` : ''}`;
      } else if (m.replySnippet) {
        head += ` ↪ (older) ${m.replySnippet}`;
      } else {
        head += ' ↪ (older message)';
      }
    }

    // old walls of text get clipped, new stuff is shown in full
    const body = isNew ? m.content : clip(m.content, 600);
    const tags: string[] = [];
    if (m.mentionsSelf && !m.self) tags.push('pinged you');
    if (interruptedBy.has(m.id)) tags.push('interrupted you');
    if (m.edited) tags.push('edited');
    for (const a of m.attachments) {
      const isImage = a.type.startsWith('image/');
      tags.push(`${isImage ? 'image' : 'file'}: ${a.name}`);
      if (isImage) images.push({ url: a.url, ref });
    }
    tags.push(...m.extras);
    if (m.reactions.size) {
      tags.push(
        `reactions: ${[...m.reactions].map(([e, n]) => (n > 1 ? `${e}×${n}` : e)).join(' ')}`
      );
    }

    lines.push(`${head}: ${body}${tags.length ? ` [${tags.join('] [')}]` : ''}`);
  }

  return {
    text: lines.join('\n'),
    refs,
    // only the newest images are worth the latency
    images: images.slice(-cfg.maxImages),
    newCount,
    lastId: window.at(-1)?.id,
  };
}
