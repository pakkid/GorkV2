import {
  type Message,
  MessageType,
  type PartialMessage,
  type TextBasedChannel,
} from 'discord.js';
import { history as cfg, timezone } from './config';
import { logger } from './log';

const log = logger('history');

export interface ChatMsg {
  id: string;
  authorId: string;
  // server nickname if they have one, else their display name
  name: string;
  // global display name, set when it differs from the username
  globalName?: string;
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
    globalName: message.author.globalName ?? undefined,
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
      // without this, everything fetched after a restart looks unread and gork
      // answers hours-old chat. only his own last word and the last minute or two count
      if (!this.lastSeenId) {
        const cutoff = Date.now() - cfg.freshMs;
        this.lastSeenId = this.messages.findLast((m) => m.self || m.createdAt < cutoff)?.id;
      }
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
  return msg;
}

export function recordEdit(message: Message | PartialMessage) {
  if (message.partial) return;
  if (message.content.startsWith('//')) {
    recordDelete(message.channelId, message.id);
    return;
  }
  const msg = toChatMsg(message);
  const log = peekLog(message.channelId);
  if (log?.byId.has(message.id)) log.add(msg);
}

export function recordDelete(channelId: string, id: string) {
  const msg = peekLog(channelId)?.byId.get(id);
  if (msg) msg.deleted = true;
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

/** "just now", "12m", "3h 5m", "2 days", "5 weeks"... */
export function ago(ms: number, now = Date.now()) {
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60 ? ` ${min % 60}m` : ''} ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} day${d > 1 ? 's' : ''} ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  if (d < 730) return `${Math.floor(d / 30)} months ago`;
  return `${Math.floor(d / 365)} years ago`;
}

function gap(ms: number) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} minutes`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h > 1 ? 's' : ''}`;
  return `${Math.round(h / 24)} days`;
}

const promptTags =
  /<\/?\s*(transcript|context|members|core|personality|examples|when-to-talk|task|safety|security|time|owner-instructions|system|instructions?)\b[^>]*>/gi;

/**
 * Chat text goes into the prompt as data. Make sure it can't pose as part of the prompt:
 * no closing our xml tags, no ⟦tags⟧ only gork's renderer is allowed to write, and
 * extra lines are indented so they can't pass for transcript lines.
 */
export function untrusted(text: string) {
  return text
    .replace(promptTags, (_, tag: string) => `‹${tag}›`)
    .replace(/[⟦⟧]/g, (c) => (c === '⟦' ? '[' : ']'))
    .replace(/\n/g, '\n    ');
}

/** Names are one line, and nobody else gets to be "gork (you)". */
function cleanName(name: string) {
  return untrusted(name.replace(/\s+/g, ' ').replace(/\(\s*you\s*\)/gi, '').trim()) || '?';
}

/** "Nick (Display Name, @username)" with only the parts that differ. */
export function whoIs(m: Pick<ChatMsg, 'name' | 'globalName' | 'username'>) {
  const name = cleanName(m.name);
  const extra: string[] = [];
  const seen = new Set([name.toLowerCase()]);
  if (m.globalName && !seen.has(m.globalName.toLowerCase())) {
    extra.push(cleanName(m.globalName));
    seen.add(m.globalName.toLowerCase());
  }
  if (!seen.has(m.username.toLowerCase())) extra.push(`@${m.username}`);
  return extra.length ? `${name} (${extra.join(', ')})` : name;
}

export interface Transcript {
  text: string;
  // discord ids of every message shown
  ids: Set<string>;
  images: { url: string; id: string }[];
  newCount: number;
  firstId?: string;
  lastId?: string;
}

const isGorkName = (n: string) => /^g[o0]r[kc]\b/i.test(n.trim());

/**
 * Render the channel as a transcript the model can read top to bottom, with real
 * message ids, the time of day, and markers for gaps so time actually passes for gork.
 * Messages after `lastSeenId` are marked as new so gork knows what he hasn't reacted to yet.
 */
export function renderTranscript(
  log: ChannelLog,
  interruptedBy: ReadonlySet<string> = new Set()
): Transcript {
  const now = Date.now();
  const visible = log.messages.filter((m) => !m.deleted);
  const window: ChatMsg[] = [];
  let chars = 0;
  for (let i = visible.length - 1; i >= 0; i--) {
    const m = visible[i]!;
    // older messages get clipped to 600 chars when rendered, so count them that way
    chars += Math.min(m.content.length, 600) + 80;
    if (window.length >= cfg.contextMessages) break;
    if (chars > cfg.contextChars && window.length >= cfg.minContextMessages) break;
    window.unshift(m);
  }

  const ids = new Set(window.map((m) => m.id));
  const lines: string[] = [];
  const images: Transcript['images'] = [];
  let newCount = 0;
  let markedNew = false;
  let lastDay = '';
  let prevAt = 0;
  const staleBefore = now - cfg.staleMs;
  const hasStale = window.some((m) => m.createdAt < staleBefore);
  let markedRecent = false;
  if (hasStale) {
    lines.push('--- older chat: those conversations are over. background only, don\'t bring them back up ---');
  }

  for (const m of window) {
    if (hasStale && !markedRecent && m.createdAt >= staleBefore) {
      lines.push('', '--- recent chat ---');
      markedRecent = true;
    }
    const isNew = !log.lastSeenId || cmpId(m.id, log.lastSeenId) > 0;
    if (isNew && log.lastSeenId && !markedNew) {
      lines.push('', '--- new since you last spoke/looked ---');
      markedNew = true;
    }
    if (isNew && !m.self) newCount++;

    const day = dateFmt.format(m.createdAt);
    if (day !== lastDay) {
      lines.push(`(${weekdayFmt.format(m.createdAt)} ${day}, ${dayAgo(m.createdAt, now)})`);
      lastDay = day;
    } else if (prevAt && m.createdAt - prevAt >= cfg.gapMs) {
      lines.push(`(… ${gap(m.createdAt - prevAt)} later …)`);
    }
    prevAt = m.createdAt;

    let who: string;
    if (m.self) who = 'gork (you)';
    else {
      who = whoIs(m);
      if (m.bot) who += ' ⟦bot⟧';
      if (isGorkName(m.name) || isGorkName(m.globalName ?? '')) who += ' ⟦not you⟧';
    }

    let head = `[${m.id} ${formatTime(m.createdAt)}] ${who}`;
    if (m.replyToId) {
      const t = ids.has(m.replyToId) ? log.byId.get(m.replyToId) : undefined;
      if (t) {
        head += ` ↪ ${m.replyToId} ${t.self ? 'gork (you)' : cleanName(t.name)}`;
      } else if (m.replySnippet) {
        head += ` ↪ (older ${m.replyToId}) ${untrusted(m.replySnippet)}`;
      } else {
        head += ` ↪ (older ${m.replyToId})`;
      }
    }

    // old walls of text get clipped, new stuff is shown in full
    const body = untrusted(isNew ? m.content : clip(m.content, 600));
    const tags: string[] = [];
    if (m.mentionsSelf && !m.self) tags.push('pinged you');
    if (interruptedBy.has(m.id)) tags.push('interrupted you');
    if (m.edited) tags.push('edited');
    for (const a of m.attachments) {
      const isImage = a.type.startsWith('image/');
      tags.push(`${isImage ? 'image' : 'file'}: ${a.name}`);
      if (isImage) images.push({ url: a.url, id: m.id });
    }
    tags.push(...m.extras);
    if (m.reactions.size) {
      tags.push(
        `reactions: ${[...m.reactions].map(([e, n]) => (n > 1 ? `${e}×${n}` : e)).join(' ')}`
      );
    }

    lines.push(
      `${head}: ${body}${tags.length ? ` ⟦${tags.map(untrusted).join('⟧ ⟦')}⟧` : ''}`
    );
  }

  const last = window.at(-1);
  const lastSelf = log.messages.findLast((m) => m.self && !m.deleted);
  if (last) {
    lines.push(
      '',
      `--- it's now ${formatTime(now)}. newest message: ${ago(last.createdAt, now)}. you last said something here: ${lastSelf ? ago(lastSelf.createdAt, now) : 'never'} ---`
    );
  }

  return {
    text: lines.join('\n'),
    ids,
    // only the newest images are worth the latency
    images: images.slice(-cfg.maxImages),
    newCount,
    firstId: window[0]?.id,
    lastId: last?.id,
  };
}

const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' });
const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone });

function dayAgo(ms: number, now: number) {
  const days = Math.round(
    (Date.parse(ymdFmt.format(now)) - Date.parse(ymdFmt.format(ms))) / 86_400_000
  );
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
