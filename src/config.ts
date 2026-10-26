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
};

export const timing = {
  // wait this long after a ping for follow-up messages before thinking
  pingDebounceMs: 250,
  // wait this long after normal chatter before deciding whether to chime in
  idleDebounceMs: 1500,
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
