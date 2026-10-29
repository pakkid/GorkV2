import { ActivityType, type PresenceStatusData } from 'discord.js';

export const keywords = ['gork', 'grok'];
// where gork lives: his clock (transcript times, "it's 5am") and where he says he's from.
// TZ / GORK_LOCATION in the env; set them to wherever the server's people actually are
export const timezone =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
export const location = process.env.GORK_LOCATION || 'New York, USA';

// how much chat gork keeps in his head per channel
export const history = {
  // messages kept per channel (in RAM only, gone on restart)
  maxMessages: 200,
  // messages fetched from discord the first time gork looks at a channel
  backfill: 100,
  // messages shown to the model each turn
  contextMessages: 120,
  // ...and never fewer than this, even when walls of text hit the char cap below
  minContextMessages: 50,
  // hard cap on transcript size so huge walls of text don't blow up latency
  contextChars: 40_000,
  // channels kept in memory before the least recently used is dropped
  maxChannels: 500,
  // images from the newest messages that get sent to the model
  maxImages: 4,
  // chat older than this is marked as old news so gork doesn't drag it back up
  staleMs: 2 * 60 * 60 * 1000,
  // a silence this long between two messages gets called out in the transcript
  gapMs: 30 * 60 * 1000,
  // on a fresh start, backfilled messages younger than this still count as new
  freshMs: 2 * 60 * 1000,
  // gork's own recent messages listed back to him so he stops reusing bits
  recentSelf: 15,
};

// the server member list gork gets to see
export const members = {
  // members listed in the prompt (people active in the channel come first)
  roster: 150,
  // don't pull the member list of servers bigger than this
  fetchMax: 25_000,
};

export const timing = {
  // wait this long after a ping for follow-up messages before thinking
  pingDebounceMs: 250,
  // wait this long after normal chatter before deciding whether to chime in
  idleDebounceMs: 1500,
  // pause between gork's messages in one turn, like he's typing each one:
  // base + per character, ±25% jitter, capped
  messageGapMs: 1200,
  perCharMs: 45,
  maxMessageGapMs: 6000,
  // give up on a model call after this long
  timeoutMs: 45_000,
};

export const limits = {
  // after this many "stay quiet" decisions in a row, stop watching a channel until pinged
  maxQuietStreak: 12,
  quietCooldownMs: 30 * 60 * 1000,
  // max model calls per channel per minute
  callsPerMinute: 15,
  // /shutup duration
  silenceMs: 6 * 60 * 60 * 1000,
};

export const statuses: PresenceStatusData[] = ['online', 'idle', 'dnd'];

export const activities: { type: ActivityType; name: string }[] = [
  { type: ActivityType.Competing, name: 'painting' },
  { type: ActivityType.Listening, name: 'music' },
  { type: ActivityType.Watching, name: 'tv' },
  { type: ActivityType.Playing, name: 'in the gym' },
];

// $ per million tokens [input, output], for estimating cost when the provider doesn't
// report it (OpenRouter does). AI_PRICES in the env adds to / overrides this.
// deepseek: worked out from the eclipsesystems gateway's own estimated_cost (oct 2026);
// the other two are the vendors' list prices
export const prices: Record<string, [number, number]> = {
  'deepseek/deepseek-v4.1-flash': [0.06, 0.18],
  'minimax-m3.1-flash': [0.15, 0.6],
  'z-ai/glm-5.3-flash': [0.15, 0.5],
};
