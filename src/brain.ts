import type { Message, SendableChannels } from 'discord.js';
import { contextPrompt, systemPrompt } from './ai/prompt';
import { type Action, think } from './ai/think';
import { crawlChannel, searchArchive } from './archive';
import { archive, keywords, limits, timezone, timing } from './config';
import {
  type ChatMsg,
  channelLog,
  renderTranscript,
  type Transcript,
} from './history';
import { logger } from './log';
import { modeOf, settings } from './settings';

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
    crawlChannel(message.channel);
  }
  Object.assign(state, describePlace(message));
  state.channel = message.channel;
  return state;
}

/** Called for every human message gork can see. Decides if he should think about the channel. */
export function onMessage(message: Message, msg: ChatMsg) {
  // someone talked while gork was mid-thought after he'd already started talking
  const busy = states.get(message.channelId);
  if (busy?.abort && busy.spoke > 0 && !busy.abort.signal.aborted) {
    log.info(`${busy.place}: ${msg.name} interrupted gork`);
    busy.interruptedBy.push(msg.id);
    busy.abort.abort();
    schedule(busy, true);
    return;
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
    const said: string[] = [];
    const searches: string[] = [];
    let acted = 0;

    // gork can look things up in the channel archive, then think again with the results
    for (let round = 0; round <= archive.maxSearches; round++) {
      const canSearch = round < archive.maxSearches;
      const wanted: string[] = [];

      for await (const action of think({
        system: systemPrompt(safe),
        prompt: contextPrompt({
          place: state.place,
          topic: state.topic,
          time: nowFmt.format(Date.now()),
          transcript: transcript.text,
          pinged: urgent,
          interrupted: [...interruptedBy]
            .map((id) => chLog.byId.get(id)?.name)
            .filter((n): n is string => !!n),
          searches,
          said,
          canSearch,
        }),
        images: round === 0 ? transcript.images : [],
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break;
        if (action.type === 'search') {
          if (canSearch && action.text.trim()) wanted.push(action.text.trim());
          continue;
        }
        if (acted === 0) {
          log.info(`${state.place}: first message after ${Date.now() - started}ms`);
        }
        const text = await perform(state.channel, transcript, action);
        if (text) {
          acted++;
          state.spoke++;
          said.push(text);
        }
      }

      if (!wanted.length || abort.signal.aborted) break;
      if (!urgent && round === 0) stopTyping = startTyping(state.channel);
      for (const query of wanted.slice(0, 2)) {
        log.info(`${state.place}: searching archive for "${query}"`);
        searches.push(
          `<search query="${query}">\n${searchArchive(state.id, query, transcript.refs.get(1))}\n</search>`
        );
      }
    }

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

const prefix = /^\s*(?:\[#?\d+[^\]]*\]\s*)?(?:gork(?: \(you\))?\s*:\s*)/i;

// gork doesn't do emojis, even if the model slips one in
const emoji =
  /<a?:\w+:\d+>|[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;

function clean(text: string) {
  return text
    .replace(prefix, '')
    .replace(emoji, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function chunks(text: string) {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += 2000) out.push(text.slice(i, i + 2000));
  return out;
}

const allowedMentions = { parse: ['users' as const], repliedUser: true };

async function resolveTarget(
  channel: SendableChannels,
  transcript: Transcript,
  ref: number | null
) {
  const id = ref == null ? undefined : transcript.refs.get(ref);
  if (!id) return;
  return (
    channel.messages.cache.get(id) ??
    (await channel.messages.fetch(id).catch(() => undefined))
  );
}

async function perform(
  channel: SendableChannels,
  transcript: Transcript,
  action: Action
): Promise<string | undefined> {
  try {
    const text = clean(action.text);
    if (!text) return;
    const [first, ...rest] = chunks(text);
    const target =
      action.type === 'reply'
        ? await resolveTarget(channel, transcript, action.to)
        : undefined;

    if (target) {
      await target.reply({
        content: first!,
        allowedMentions,
        failIfNotExists: false,
      });
    } else {
      await channel.send({ content: first!, allowedMentions });
    }
    for (const part of rest) await channel.send({ content: part, allowedMentions });
    return text;
  } catch (error) {
    log.warn(`failed to ${action.type}`, error);
    return;
  }
}
