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
| Reply target | often wrong | model points at transcript `#numbers`, can reply to any message |
| Memory | Pinecone vector memories | **none**. He only sees the last ~120 messages of a channel, held in RAM and gone on restart. Nothing people say is written to disk |
| Interruptions | ignored | talk over him mid-reply and he stops, then gets mad at you |
| Personality | v1 prompts | **the same v1 prompts** (core, personality, examples, when to talk, safety), plus behaviour modifiers and instructions you set in the web ui |
| Tools | web search, images, reacts, user lookup, DMs | **web search** (Exa, optional) and **reacts**; emojis allowed |
| Infra | Redis + Pinecone + Deepgram + Exa + Langfuse | just Discord + one OpenRouter-compatible key (+ an optional Exa key for web search); settings saved to `data/settings.json`, stats to `data/gork.db` |

## Setup

Needs Node 22+. [Create a bot](https://discord.com/developers/applications) and turn on the **Message Content** and **Server Members** intents (Bot tab → Privileged Gateway Intents).

```bash
npm install
cp .env.example .env   # fill it in
npm run dev
```

Set `EXA_API_KEY` ([Exa](https://dashboard.exa.ai/api-keys), what the original gork used) to let him search the web; without it he just doesn't search.

Any OpenRouter-compatible endpoint works (`AI_BASE_URL`), including the Hack Club proxy. Pick a fast model with structured-output support; `AI_REASONING=minimal` keeps latency down.

## Deploy with Portainer

1. **Stacks → Add stack → Repository**
2. Repository URL: this repo, reference `refs/heads/main`, compose path `docker-compose.yml`
3. Under **Environment variables** add at least `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and `AI_API_KEY` (optional: `DISCORD_OWNER_ID`, `EXA_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_FALLBACK_MODELS`, `AI_REASONING`, `TZ`, `GORK_LOCATION`). If the repo is private, turn on **Authentication** with a GitHub token.
4. Deploy. Slash commands register themselves on startup.

Settings and stats live in the `gork-data` volume, so redeploys keep them. To update, hit **Pull and redeploy** on the stack (or enable GitOps auto-updates).

Plain Docker works the same: put the variables in `.env` and run `docker compose up -d --build`.

## Stats and behaviour editor

Gork serves a small web page on port `8787` (`WEB_PORT`, `0` turns it off). Open `http://<server's LAN ip>:8787`.

- **Stats**: API cost, tokens, model calls, messages he sent, how often he talks, the channels he talks in most, and a per-model breakdown, per server and time range. Cost comes from OpenRouter when it reports it; otherwise from the price table in `src/config.ts` (the default models are filled in), which `AI_PRICES` (`model=in/out,...` in $ per million tokens) can add to or override. Gateways that don't report token counts while streaming get estimates from text length, marked as estimated.
- **Behaviour**: modifiers you switch on and off (a few presets come with it, all off) and free-text instructions, for everywhere or per server. Server settings stack on top of "Everywhere". Changes apply to his next message; "Show the full prompt" shows exactly what he gets.

It's LAN only: requests from anything other than a private, loopback or link-local address are refused, as are requests whose `Host` isn't an ip, `localhost`, a bare hostname or a `.local`/`.lan`/`.home.arpa`/`.internal` name. There's no password, so anyone on your network can use it. In Docker, set `WEB_BIND` to the host's LAN ip so the port isn't published on other interfaces either. Don't put it behind a reverse proxy on the same machine: everything would look local.

## Commands

Gork starts with **no channel access**. Whitelist a channel with `/mode set scope:Channel value:Relevance` (threads follow their parent channel), or a whole server with `scope:Server`. DMs only work with the bot owner. Settings commands need `DISCORD_OWNER_ID` set.

| Command | What it does |
|---|---|
| `/mode set/show/clear` | When gork talks: `relevance` (he decides), `ping`, `ping+keyword`, `none` (bot owner only) |
| `/safety set/show/clear` | `unfiltered` or `safe` (SFW) per server/channel (bot owner only) |
| `/shutup` | silence gork in a channel for 6h; pinging him wakes him back up (bot owner only) |
| `/ping` | latency check |

Start a message with `//` to hide it from gork.

Tuning knobs (context size, debounce, rate limits) live in `src/config.ts`.
