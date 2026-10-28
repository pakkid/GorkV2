import { ActivityType, type PresenceStatusData } from 'discord.js';

export const keywords = ['gork', 'grok'];
export const timezone = 'America/New_York';
export const location = 'New York, USA';

// how much chat gork keeps in his head per channel
export const history = {
  // messages kept in memory per channel
  maxMessages: 200,
  // messages fetched from discord the first time gork looks at a channel
  backfill: 100,
  // messages shown to the model each turn
  contextMessages: 120,
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

// notes gork chooses to keep about people and the server
export const memory = {
  // notes kept per server (oldest dropped first)
  maxNotes: 200,
  // newest notes shown to the model each turn
  inPrompt: 40,
  // /memory reinit: how much recent chat gork reads to rebuild his notes,
  // and how much of it goes into each model call
  rebuildMessages: 20_000,
  rebuildChunkChars: 30_000,
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

// long-term memory: every message gork sees is saved to data/archive.db
export const archive = {
  // walk back through each active channel's entire history in the background
  crawl: true,
  maxPerChannel: 250_000,
  crawlDelayMs: 750,
  // after downtime, max pages (of 100) to fetch to reconnect with the archive
  maxGapPages: 50,
  // what a search returns
  searchHits: 6,
  searchContext: 2,
  searchChars: 6000,
  // searches gork may run before he has to answer
  maxSearches: 2,
};
