// Talk to gork's brain without discord: builds a fake channel, sends the real
// prompt to the configured model and prints what he'd do.
// usage: npm run try -- "gork whats 7 times 8"
process.env.DISCORD_TOKEN ||= 'unused';
process.env.DISCORD_CLIENT_ID ||= 'unused';
process.env.DATA_DIR ||= 'data/try';

const { contextPrompt, systemPrompt } = await import('../src/ai/prompt');
const { think } = await import('../src/ai/think');
const { env } = await import('../src/env');
const { ChannelLog, renderTranscript } = await import('../src/history');
const { web } = await import('../src/config');
const { canSearchWeb, searchWeb } = await import('../src/web-search');

const message = process.argv.slice(2).join(' ') || 'gork what do u think of my new haircut';
const now = Date.now();
const log = new ChannelLog();
let id = 1000;
const add = (name: string, content: string, opts: { self?: boolean; ping?: boolean } = {}) =>
  log.add({
    id: String(1300000000000000000n + BigInt(id++)),
    authorId: name,
    name,
    username: name.toLowerCase(),
    bot: false,
    self: !!opts.self,
    content,
    attachments: [],
    extras: [],
    reactions: new Map(),
    mentionsSelf: !!opts.ping,
    createdAt: now - (2000 - id) * 1000,
    edited: false,
    deleted: false,
  });

add('Alex', 'anyone up for minecraft tonight');
add('Sam', 'ye after dinner');
add('gork', 'minecraft is for people who peaked in 2011', { self: true });
log.lastSeenId = String(1300000000000000000n + BigInt(id - 1));
add('Alex', 'ok gork nobody asked');
add('You', message, { ping: true });

const transcript = renderTranscript(log);
const prompt = (searches: string[], said: string[], canSearch: boolean) =>
  contextPrompt({
    place: 'the "test" Discord server, #general',
    time: new Date().toString(),
    transcript: transcript.text,
    pinged: true,
    interrupted: [],
    recent: log.messages.filter((m) => m.self).map((m) => m.content),
    members: 'Alex (@alex) <@111>\nSam (@sam) <@222>\nNikolai (Niko B, @niko.b) <@333>',
    emojis: ':pepela: :skull_cry:',
    searches,
    said,
    canSearch,
  });

console.log(`model: ${env.AI_MODEL} via ${env.AI_PROVIDER} ${env.AI_BASE_URL ?? ''}`);
console.log(`web search: ${canSearchWeb ? 'on' : 'off (no EXA_API_KEY)'}\n`);
console.log(transcript.text, '\n');
const started = Date.now();
let count = 0;
const searches: string[] = [];
const said: string[] = [];
// same loop as the bot: search, then think again with the results
for (let round = 0; round <= web.maxSearches; round++) {
  const canSearch = canSearchWeb && round < web.maxSearches;
  const wanted: string[] = [];
  for await (const action of think({
    system: systemPrompt(false, undefined, canSearchWeb),
    prompt: prompt(searches, said, canSearch),
    images: [],
  })) {
    count++;
    console.log(`+${Date.now() - started}ms`, action.type, action.to ?? '', JSON.stringify(action.text));
    if (action.type === 'search') {
      if (canSearch) wanted.push(action.text);
    } else {
      said.push(action.type === 'react' ? `(reacted ${action.text})` : action.text);
    }
  }
  if (!wanted.length) break;
  for (const q of wanted.slice(0, 2)) searches.push(`<search query="${q}">\n${await searchWeb(q)}\n</search>`);
  console.log(`  (searched ${wanted.slice(0, 2).length}, thinking again)`);
}
console.log(`\n${count} actions in ${Date.now() - started}ms`);
