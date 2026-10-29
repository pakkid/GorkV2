import { setTimeout as sleep } from 'node:timers/promises';
import type { Guild, Message, SendableChannels } from 'discord.js';
import { contextPrompt, systemPrompt } from './ai/prompt';
import { type Action, think } from './ai/think';
import { history, keywords, limits, timezone, timing, web } from './config';
import {
  type ChannelLog,
  type ChatMsg,
  channelLog,
  renderTranscript,
  type Transcript,
  untrusted,
} from './history';
import { logger } from './log';
import { mentionNames, roster } from './members';
import { modeOf, ownerRules, settings } from './settings';
import { recordSent, recordTurn } from './stats';
import { canSearchWeb, searchWeb } from './web-search';

const log = logger('brain');

interface ChannelState {
  id: string;
  channel: SendableChannels;
  guildId: string | null;
  place: string;
  topic: string | null;
  timer?: NodeJS.Timeout;
  running: boolean;
  rerun: boolean;
  urgent: boolean;
  quietStreak: number;
  quietUntil: number;
  calls: number[];
  // set while gork is mid-turn, so someone talking over him can cut him off
  abort?: AbortController;
  spoke: number;
  interruptedBy: string[];
}

const states = new Map<string, ChannelState>();

const nowFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: timezone,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function describePlace(message: Message) {
  const { channel, guild, author } = message;
  if (!guild) return { place: `DMs with ${author.displayName} (@${author.username})`, topic: null };
  const name = 'name' in channel && channel.name ? channel.name : 'unknown';
  const topic = 'topic' in channel ? (channel.topic ?? null) : null;
  return { place: `the "${guild.name}" Discord server, #${name}`, topic };
}

function stateFor(message: Message): ChannelState | undefined {
  if (!message.channel.isSendable()) return;
  let state = states.get(message.channelId);
  if (!state) {
    state = {
      id: message.channelId,
      channel: message.channel,
      guildId: message.guildId,
      place: '',
      topic: null,
      running: false,
      rerun: false,
      urgent: false,
      quietStreak: 0,
      quietUntil: 0,
      calls: [],
      spoke: 0,
      interruptedBy: [],
    };
    states.set(message.channelId, state);
  }
  Object.assign(state, describePlace(message));
  state.channel = message.channel;
  return state;
}

/** Called for every human message gork can see. Decides if he should think about the channel. */
export function onMessage(message: Message, msg: ChatMsg) {
  // someone talked while gork was partway through his messages. he still sends the rest
  // (cutting them off lost things he'd promised, like pings); they just get marked as
  // having talked over him, and the message is handled normally below
  const busy = states.get(message.channelId);
  if (busy?.abort && busy.spoke > 0 && !busy.abort.signal.aborted) {
    log.info(`${busy.place}: ${msg.name} talked over gork`);
    busy.interruptedBy.push(msg.id);
  }

  const isDM = !message.guild;
  const mode = modeOf(message);
  if (mode === 'none') return;

  const lower = message.content.toLowerCase();
  const named = keywords.some((k) => lower.includes(k));
  const pinged = msg.mentionsSelf;

  if (pinged) settings.unsilence(message.channelId);
  else if (settings.isSilenced(message.channelId)) return;

  const direct =
    isDM || pinged || (named && (mode === 'ping+keyword' || mode === 'relevance'));
  if (!direct && mode !== 'relevance') return;

  const state = stateFor(message);
  if (!state) return;

  if (direct) {
    state.quietStreak = 0;
    state.quietUntil = 0;
  } else if (state.quietUntil > Date.now()) {
    return;
  }

  // start pulling history right away so it's ready when the timer fires
  void channelLog(state.id).backfill(state.channel);
  schedule(state, direct);
}

function schedule(state: ChannelState, urgent: boolean) {
  if (urgent) state.urgent = true;
  if (state.running) {
    state.rerun = true;
    return;
  }
  clearTimeout(state.timer);
  state.timer = setTimeout(
    () => void run(state),
    state.urgent ? timing.pingDebounceMs : timing.idleDebounceMs
  );
}

function startTyping(channel: SendableChannels) {
  const send = () => channel.sendTyping().catch(() => {});
  send();
  const interval = setInterval(send, 8000);
  return () => clearInterval(interval);
}

async function run(state: ChannelState) {
  state.running = true;
  state.rerun = false;
  const urgent = state.urgent;
  state.urgent = false;
  let stopTyping = () => {};

  try {
    const now = Date.now();
    state.calls = state.calls.filter((t) => now - t < 60_000);
    if (state.calls.length >= limits.callsPerMinute && !urgent) {
      log.debug(`rate limited in ${state.id}`);
      return;
    }

    const chLog = channelLog(state.id);
    await chLog.backfill(state.channel);
    const interruptedBy = new Set(state.interruptedBy);
    state.interruptedBy = [];
    const transcript = renderTranscript(chLog, interruptedBy);
    if (transcript.newCount === 0 && !urgent) return;

    state.calls.push(now);
    chLog.lastSeenId = transcript.lastId;
    if (urgent) stopTyping = startTyping(state.channel);

    const safe = settings.safety(state.guildId, state.id) === 'safe';
    const abort = new AbortController();
    state.abort = abort;
    state.spoke = 0;
    const started = Date.now();
    let acted = 0;
    let lastSent = 0;
    const guild = 'guild' in state.channel ? state.channel.guild : null;
    const members = guild ? roster(guild, chLog).text : undefined;
    const recent = chLog.messages
      .filter((m) => m.self && !m.deleted)
      .slice(-history.recentSelf)
      .map((m) => m.content.replace(/\s+/g, ' ').slice(0, 160));
    // anything gork already said here, normalized, so he can't post the same line twice
    const spoken = new Set(chLog.messages.filter((m) => m.self).map((m) => normalize(m.content)));

    const emojis = guild ? emojiList(guild) : undefined;
    const said: string[] = [];
    const searches: string[] = [];

    // gork can look things up on the web, then think again with the results
    for (let round = 0; round <= web.maxSearches; round++) {
      const canSearch = canSearchWeb && round < web.maxSearches;
      const wanted: string[] = [];

      for await (const action of think({
        system: systemPrompt(safe, ownerRules(state.guildId), canSearchWeb),
        prompt: contextPrompt({
          place: state.place,
          topic: state.topic,
          time: nowFmt.format(Date.now()),
          transcript: transcript.text,
          pinged: urgent,
          interrupted: [...interruptedBy]
            .map((id) => chLog.byId.get(id)?.name)
            .filter((n): n is string => !!n),
          recent,
          members,
          emojis,
          searches,
          said,
          canSearch,
        }),
        images: round === 0 ? transcript.images : [],
        signal: abort.signal,
        where: { kind: 'chat', guildId: state.guildId, channelId: state.id },
      })) {
        if (abort.signal.aborted) break;
        if (action.type === 'search') {
          if (canSearch && action.text.trim()) wanted.push(action.text.trim());
          continue;
        }
        if (action.type === 'react') {
          if (await react(state.channel, guild, action)) {
            acted++;
            said.push(`(reacted ${action.text} to ${action.to})`);
          }
          continue;
        }
        const key = normalize(action.text);
        // short stuff like "no" or "lmao" is allowed to come up again
        if (key.length >= 10 && spoken.has(key)) {
          log.info(`${state.place}: dropped a repeat: ${action.text}`);
          continue;
        }
        spoken.add(key);
        if (acted === 0) {
          log.info(`${state.place}: first message after ${Date.now() - started}ms`);
          // nobody saw "typing" while he decided whether to butt in, so type it out now
          if (!urgent && !(await pace(state.channel, action.text, Date.now(), abort.signal))) break;
        } else if (!(await pace(state.channel, action.text, lastSent, abort.signal))) {
          break;
        }
        const text = await perform(state.channel, guild, chLog, action);
        if (text) {
          lastSent = Date.now();
          acted++;
          state.spoke++;
          said.push(text);
        }
      }

      if (!wanted.length || abort.signal.aborted) break;
      if (!urgent && round === 0) stopTyping = startTyping(state.channel);
      const queries = wanted.slice(0, 2);
      log.info(`${state.place}: searching the web for ${queries.map((q) => `"${q}"`).join(', ')}`);
      const results = await Promise.all(queries.map(searchWeb));
      queries.forEach((q, i) => searches.push(`<search query="${untrusted(q).replace(/"/g, "'")}">\n${results[i]}\n</search>`));
    }

    recordTurn(state.guildId, state.id, urgent, acted > 0);
    if (acted > 0 || urgent) {
      state.quietStreak = 0;
    } else if (++state.quietStreak >= limits.maxQuietStreak) {
      log.info(`${state.place}: quiet for a while, ignoring chatter until pinged`);
      state.quietUntil = Date.now() + limits.quietCooldownMs;
      state.quietStreak = 0;
    }
  } catch (error) {
    log.error(`run failed in ${state.id}`, error);
  } finally {
    stopTyping();
    state.abort = undefined;
    state.running = false;
    if (state.rerun) schedule(state, state.urgent);
  }
}

/**
 * Wait between messages like someone typing them one at a time. Returns false if
 * gork got interrupted while waiting.
 */
async function pace(channel: SendableChannels, text: string, lastSent: number, signal: AbortSignal) {
  const jitter = 0.75 + Math.random() * 0.5;
  const want = Math.min(
    timing.maxMessageGapMs,
    (timing.messageGapMs + text.length * timing.perCharMs) * jitter
  );
  const wait = want - (Date.now() - lastSent);
  if (wait <= 0) return !signal.aborted;
  channel.sendTyping().catch(() => {});
  try {
    await sleep(wait, undefined, { signal });
  } catch {
    return false;
  }
  return true;
}

const prefix = /^\s*(?:\[#?\d+[^\]]*\]\s*)?(?:gork(?: \(you\))?\s*:\s*)?/i;

function clean(text: string) {
  return text
    .replace(prefix, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function chunks(text: string) {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 2000) out.push(text.slice(i, i + 2000));
  return out;
}

/** For spotting repeats: case, punctuation and spacing don't make a line new. */
function normalize(text: string) {
  return text.toLowerCase().replace(/<@!?\d+>/g, '@').replace(/[^\p{L}\p{N}@]+/gu, '');
}

// gork can ping people, but never @everyone/roles, and never a whole raid's worth at once
const maxPings = 5;
function allowedMentions(text: string) {
  const users = [...new Set([...text.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]!))];
  return { users: users.slice(0, maxPings), repliedUser: true };
}

async function resolveTarget(channel: SendableChannels, id: string | null) {
  if (!id || !/^\d{15,21}$/.test(id)) return;
  return (
    channel.messages.cache.get(id) ??
    (await channel.messages.fetch(id).catch(() => undefined))
  );
}

/**
 * The model is told to ping with <@id>, but it still writes "@niko" sometimes, which
 * shows up as plain text. Turn @name / @username of anyone in the server (or the
 * channel's history, in DMs) into a real ping. Longest name wins, so "@niko bellic"
 * beats "@niko".
 */
export function linkMentions(text: string, guild: Guild | null, chLog: ChannelLog) {
  if (!text.includes('@')) return text;
  const ids = mentionNames(guild, chLog);
  if (!ids.size) return text;
  // <@name> is a common slip too
  text = text.replace(/<@!?([^\d>][^>]{0,31})>/g, '@$1');
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at < 0 || /[\p{L}\p{N}_<]/u.test(text[at - 1] ?? '')) {
      out += text.slice(i, at < 0 ? undefined : at + 1);
      if (at < 0) break;
      i = at + 1;
      continue;
    }
    out += text.slice(i, at);
    let hit: { id: string; len: number } | undefined;
    // discord names are at most 32 chars
    for (let len = Math.min(32, text.length - at - 1); len > 0; len--) {
      const name = text.slice(at + 1, at + 1 + len);
      const id = ids.get(name.toLowerCase());
      if (id && !/[\p{L}\p{N}_]/u.test(text[at + 1 + len] ?? '')) {
        hit = { id, len };
        break;
      }
    }
    if (hit) {
      out += `<@${hit.id}>`;
      i = at + 1 + hit.len;
    } else {
      out += '@';
      i = at + 1;
    }
  }
  return out;
}

/**
 * gork links a message by writing #<message id>. Turn that into a jump link, and drop
 * ids that aren't messages he can see so he can't link to something he made up.
 */
export function linkRefs(text: string, chLog: ChannelLog, channelId: string, guildId: string | null) {
  return text.replace(/(?<![\p{L}\p{N}_<@!&\/:])(#?)(\d{17,20})(?![\d>])/gu, (match, hash: string, id: string) => {
    if (chLog.byId.has(id)) {
      return `https://discord.com/channels/${guildId ?? '@me'}/${channelId}/${id}`;
    }
    return hash ? '' : match;
  });
}

/** The server's own emojis, for the prompt: `:name:` is how gork writes them. */
function emojiList(guild: Guild) {
  const names = [...guild.emojis.cache.values()]
    .filter((e) => e.available !== false && e.name)
    .slice(0, 80)
    .map((e) => `:${e.name}:`);
  return names.length ? names.join(' ') : undefined;
}

/** `:name:` only renders in discord as `<:name:id>`, so swap in the real thing for server emojis. */
function customEmojis(text: string, guild: Guild | null) {
  if (!guild) return text;
  return text.replace(/(?<![<\w]):(\w{2,32}):(?!\d)/g, (match, name: string) => {
    const e = guild.emojis.cache.find((x) => x.name === name);
    return e ? e.toString() : match;
  });
}

/** One emoji as discord.js wants it for a reaction, or undefined if it isn't one. */
function reaction(raw: string, guild: Guild | null) {
  const custom = /^<a?:\w+:(\d+)>$/.exec(raw);
  if (custom) return custom[1];
  const name = /^:?(\w{2,32}):?$/.exec(raw)?.[1];
  if (name) return guild?.emojis.cache.find((e) => e.name === name)?.id;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(raw) ? raw : undefined;
}

async function react(channel: SendableChannels, guild: Guild | null, action: Action) {
  const target = await resolveTarget(channel, action.to);
  if (!target) return false;
  let reacted = false;
  for (const raw of action.text.trim().split(/\s+/).slice(0, 3)) {
    const emoji = reaction(raw, guild);
    if (!emoji) continue;
    try {
      await target.react(emoji);
      reacted = true;
    } catch (error) {
      log.warn(`couldn't react with ${raw}`, error);
    }
  }
  return reacted;
}

async function perform(
  channel: SendableChannels,
  guild: Guild | null,
  chLog: ChannelLog,
  action: Action
): Promise<string | undefined> {
  try {
    const guildId = 'guildId' in channel ? channel.guildId : null;
    const text = linkRefs(linkMentions(customEmojis(clean(action.text), guild), guild, chLog), chLog, channel.id, guildId)
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    if (!text) return;
    const [first, ...rest] = chunks(text);
    const target =
      action.type === 'reply'
        ? await resolveTarget(channel, action.to)
        : undefined;

    if (target) {
      await target.reply({
        content: first!,
        allowedMentions: allowedMentions(first!),
        failIfNotExists: false,
      });
    } else {
      await channel.send({ content: first!, allowedMentions: allowedMentions(first!) });
    }
    recordSent(guildId, channel.id, target ? 'reply' : 'send');
    for (const part of rest) {
      await channel.send({ content: part, allowedMentions: allowedMentions(part) });
      recordSent(guildId, channel.id, 'send');
    }
    return text;
  } catch (error) {
    log.warn(`failed to ${action.type}`, error);
    return;
  }
}
