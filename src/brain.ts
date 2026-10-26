import type { Message, SendableChannels } from 'discord.js';
import { contextPrompt, systemPrompt } from './ai/prompt';
import { type Action, think } from './ai/think';
import { keywords, limits, timezone, timing } from './config';
import {
  type ChatMsg,
  channelLog,
  renderTranscript,
  type Transcript,
} from './history';
import { logger } from './log';
import { settings } from './settings';

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
    };
    states.set(message.channelId, state);
  }
  Object.assign(state, describePlace(message));
  state.channel = message.channel;
  return state;
}

/** Called for every human message gork can see. Decides if he should think about the channel. */
export function onMessage(message: Message, msg: ChatMsg) {
  const isDM = !message.guild;
  const mode = settings.mode(message.guildId, message.channelId);
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
    const transcript = renderTranscript(chLog);
    if (transcript.newCount === 0 && !urgent) return;

    state.calls.push(now);
    chLog.lastSeenId = transcript.lastId;
    if (urgent) stopTyping = startTyping(state.channel);

    const safe = settings.safety(state.guildId, state.id) === 'safe';
    const started = Date.now();
    let acted = 0;

    for await (const action of think({
      system: systemPrompt(safe),
      prompt: contextPrompt({
        place: state.place,
        topic: state.topic,
        time: nowFmt.format(Date.now()),
        transcript: transcript.text,
        pinged: urgent,
      }),
      images: transcript.images,
    })) {
      if (acted === 0) {
        log.info(`${state.place}: first action after ${Date.now() - started}ms`);
      }
      if (await perform(state.channel, transcript, action)) acted++;
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
): Promise<boolean> {
  try {
    const text = clean(action.text);
    if (!text) return false;
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
    return true;
  } catch (error) {
    log.warn(`failed to ${action.type}`, error);
    return false;
  }
}
