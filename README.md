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
| Memory | Pinecone vector memories | **every message in the channel**, archived to SQLite (`data/archive.db`) and crawled back to the channel's first message in the background; gork searches it himself when someone brings up old stuff |
| Interruptions | ignored | talk over him mid-reply and he stops, then gets mad at you |
| Infra | Redis + Pinecone + Deepgram + Exa + Langfuse | just Discord + one OpenRouter-compatible key; settings saved to `data/settings.json` |

## Setup

Needs Node 22+. [Create a bot](https://discord.com/developers/applications) and turn on the **Message Content** intent (Bot tab → Privileged Gateway Intents).

```bash
npm install
cp .env.example .env   # fill it in
npm run dev
```

Any OpenRouter-compatible endpoint works (`AI_BASE_URL`), including the Hack Club proxy. Pick a fast model with structured-output support; `AI_REASONING=minimal` keeps latency down.

## Deploy with Portainer

1. **Stacks → Add stack → Repository**
2. Repository URL: this repo, reference `refs/heads/main`, compose path `docker-compose.yml`
3. Under **Environment variables** add at least `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and `AI_API_KEY` (optional: `DISCORD_OWNER_ID`, `AI_BASE_URL`, `AI_MODEL`, `AI_FALLBACK_MODELS`, `AI_REASONING`, `TZ`). If the repo is private, turn on **Authentication** with a GitHub token.
4. Deploy. Slash commands register themselves on startup.

Settings and the message archive live in the `gork-data` volume, so redeploys keep his memory. To update, hit **Pull and redeploy** on the stack (or enable GitOps auto-updates).

Plain Docker works the same: put the variables in `.env` and run `docker compose up -d --build`.

## Commands

Gork starts with **no channel access**. Whitelist a channel with `/mode set scope:Channel value:Relevance` (threads follow their parent channel), or a whole server with `scope:Server`. DMs only work with the bot owner. Settings commands need `DISCORD_OWNER_ID` set.

| Command | What it does |
|---|---|
| `/mode set/show/clear` | When gork talks: `relevance` (he decides), `ping`, `ping+keyword`, `none` (bot owner only) |
| `/safety set/show/clear` | `unfiltered` or `safe` (SFW) per server/channel (bot owner only) |
| `/shutup` | silence gork in a channel for 6h; pinging him wakes him back up (bot owner only) |
| `/ping` | latency check |

Start a message with `//` to hide it from gork (it's never archived either). Deleted messages are removed from the archive.

Tuning knobs (context size, debounce, rate limits) live in `src/config.ts`.
