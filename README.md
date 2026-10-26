# Welcome to Gork V2.
Gork died so we make new one.

A rewrite of [gork](https://github.com/techwithanirudh/gork): a sarcastic, human-ish Discord bot. V2 is built to be fast and to actually follow the whole conversation.

## What changed from gork v1

| | v1 | v2 |
|---|---|---|
| LLM calls per reply | 2+ (relevance check, then a tool-loop agent) | **1**: decide + write in one streamed call |
| Chat history | refetched 50 msgs from Discord + every replied-to message, every time | **kept live in memory** from gateway events, fetched once per channel |
| Context | 50 msgs, replies cut to 50 chars | up to 120 msgs, numbered transcript with reply links, edits, reactions, images, embeds, polls, forwards, and a "new since you last looked" marker |
| Sending | waits for the whole answer | **each message is sent the moment it's generated** |
| Bursts | one LLM call per message | messages are batched (250ms after a ping, 1.5s otherwise) and answered together |
| Reply target | often wrong | model points at transcript `#numbers`, can reply to / react on any message |
| Infra | Redis + Pinecone + Deepgram + Exa + Langfuse | just Discord + one OpenRouter-compatible key; settings saved to `data/settings.json` |

## Setup

Needs Node 22+. [Create a bot](https://discord.com/developers/applications) and turn on the **Message Content** and **Server Members** intents.

```bash
npm install
cp .env.example .env   # fill it in
npm run deploy         # register slash commands (pass a guild id for instant updates)
npm run dev
```

Any OpenRouter-compatible endpoint works (`AI_BASE_URL`), including the Hack Club proxy. Pick a fast model with structured-output support; `AI_REASONING=minimal` keeps latency down.

## Commands

| Command | What it does |
|---|---|
| `/mode set/show/clear` | When gork talks: `relevance` (he decides), `ping`, `ping+keyword`, `none` (mods only) |
| `/safety set/show/clear` | `unfiltered` or `safe` (SFW) per server/channel (mods only) |
| `/shutup` | silence gork in a channel for 6h; pinging him wakes him back up |
| `/ping` | latency check |

Start a message with `//` to hide it from gork.

Tuning knobs (context size, debounce, rate limits) live in `src/config.ts`.
