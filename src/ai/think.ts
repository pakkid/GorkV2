import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { SharedV4ProviderOptions } from '@ai-sdk/provider';
import { type LanguageModel, Output, streamText, type UserContent } from 'ai';
import { z } from 'zod';
import { timing } from '../config';
import { env } from '../env';
import { logger } from '../log';
import { recordUsage, type Where } from '../stats';

const log = logger('think');

// the json shape is spelled out in the prompt, so "no structured outputs" warnings are noise
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const models = [env.AI_MODEL, ...env.AI_FALLBACK_MODELS];

let modelFor: (id: string) => LanguageModel;
let providerOptions: SharedV4ProviderOptions = {};

if (env.AI_PROVIDER === 'openrouter') {
  const openrouter = createOpenRouter({ apiKey: env.AI_API_KEY, baseURL: env.AI_BASE_URL });
  // usage accounting puts the real $ cost of each call in the response
  modelFor = (id) => openrouter.chat(id, { usage: { include: true } });
  const effort = env.AI_REASONING ?? 'minimal';
  providerOptions = {
    openrouter: { reasoning: effort === 'none' ? { enabled: false } : { effort } },
  };
} else {
  const gateway = createOpenAICompatible({
    name: 'gateway',
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL ?? 'https://api.openai.com/v1',
    includeUsage: true,
  });
  modelFor = (id) => gateway.chatModel(id);
  // only sent when asked for; unknown gateways may reject it
  if (env.AI_REASONING) providerOptions = { gateway: { reasoningEffort: env.AI_REASONING } };
}

// flat + nullable instead of a union so strict json-schema providers accept it
export const actionSchema = z.object({
  type: z.enum(['reply', 'send', 'react', 'search']),
  // a string: discord ids are too big for a js number
  to: z.string().nullable().describe('message id to reply to (reply) or react to (react), null otherwise'),
  text: z.string().describe('the message text, the emojis to react with, or the web search query'),
});

export type Action = z.infer<typeof actionSchema>;

export interface ThinkInput {
  system: string;
  prompt: string;
  images: { url: string; id: string }[];
  signal?: AbortSignal;
  // what the call was for, for the stats page
  where?: Where;
}

type Streamed = ReturnType<typeof streamText>;

// never wait long on bookkeeping
const settle = <T>(p: PromiseLike<T>) =>
  Promise.race([
    Promise.resolve(p).catch(() => undefined),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000)),
  ]);

// some gateways never report usage; ~4 characters a token is close enough for a dashboard
const guessTokens = (chars: number) => Math.ceil(chars / 4);

async function track(
  result: Streamed,
  input: ThinkInput,
  model: string,
  started: number,
  ok: boolean
) {
  const [usage, meta, text] = await Promise.all([
    settle(result.usage),
    settle(result.providerMetadata),
    settle(result.text),
  ]);
  const cost = (meta?.openrouter as { usage?: { cost?: number } } | undefined)?.usage?.cost;
  const estimated = usage?.inputTokens == null;
  recordUsage(input.where ?? { kind: 'chat' }, {
    model,
    input: usage?.inputTokens ?? guessTokens(input.system.length + input.prompt.length),
    output: usage?.outputTokens ?? guessTokens(text?.length ?? 0),
    estimated,
    cached: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    reasoning: usage?.outputTokenDetails?.reasoningTokens ?? 0,
    cost: typeof cost === 'number' ? cost : undefined,
    ms: Date.now() - started,
    ok,
  });
}

/**
 * One model call that both decides whether to talk and writes the messages.
 * Actions are yielded the moment each one is fully generated, so the first
 * message hits discord while the rest are still being written.
 */
export async function* think(input: ThinkInput): AsyncGenerator<Action> {
  const content: UserContent = [{ type: 'text', text: input.prompt }];
  for (const img of input.images) {
    content.push({ type: 'text', text: `(image from message ${img.id})` });
    content.push({ type: 'image', image: new URL(img.url) });
  }

  for (const [i, model] of models.entries()) {
    const started = Date.now();
    const timeout = AbortSignal.timeout(timing.timeoutMs);
    let emitted = 0;
    let failure: unknown;

    const result = streamText({
      model: modelFor(model),
      system: input.system,
      messages: [{ role: 'user', content }],
      output: Output.array({ element: actionSchema, maxItems: 8 }),
      temperature: 0.7,
      maxRetries: 0,
      abortSignal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      providerOptions,
      onError: ({ error }) => {
        failure = error;
      },
    });

    try {
      for await (const action of result.elementStream) {
        if (emitted === 0) log.debug(`${model} first action in ${Date.now() - started}ms`);
        emitted++;
        yield action;
      }
    } catch (error) {
      failure ??= error;
    }

    // an abort from our own timeout ends the stream quietly, so it has to be called out
    if (timeout.aborted) failure ??= new Error(`timed out after ${timing.timeoutMs / 1000}s`);
    void track(result, input, model, started, !failure);
    if (input.signal?.aborted) return;

    if (!failure && emitted === 0) {
      // nothing came out of the stream: either a real "stay quiet" or output in a shape
      // the strict parser didn't accept (code fences, bare array, renamed keys...)
      const raw = await Promise.resolve(result.text).catch(() => '');
      const parsed = parseLoose(raw);
      if (parsed === undefined) {
        failure = new Error(
          raw.trim() ? `unreadable output: ${raw.trim().slice(0, 300)}` : 'empty output'
        );
      } else if (parsed.length) {
        log.info(`${model}: recovered ${parsed.length} actions from loose output`);
        for (const action of parsed) yield action;
        return;
      } else {
        log.info(`${model} chose to stay quiet (${Date.now() - started}ms)`);
        return;
      }
    }

    if (!failure) {
      log.debug(`${model} done: ${emitted} actions in ${Date.now() - started}ms`);
      return;
    }
    // once something was sent, retrying would double-post
    if (emitted > 0) {
      log.warn(`${model} died mid-stream after ${emitted} actions`, failure);
      return;
    }
    log.warn(
      `${model} failed${i < models.length - 1 ? ', trying next model' : ''}`,
      failure
    );
  }
}

/** Best-effort parse of model output that didn't match the schema exactly. undefined = not JSON at all. */
function parseLoose(raw: string): Action[] | undefined {
  const text = raw
    .replace(/```(?:json)?/gi, '')
    // a bare snowflake loses digits in JSON.parse, so quote it first
    .replace(/("to"\s*:\s*)(\d{15,})/g, '$1"$2"')
    .trim();
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }

  const obj = data as Record<string, unknown>;
  const list = Array.isArray(data)
    ? data
    : (obj.elements ?? obj.actions ?? obj.messages ?? (obj.type ? [obj] : []));
  if (!Array.isArray(list)) return undefined;

  const out: Action[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      out.push({ type: 'send', to: null, text: item });
      continue;
    }
    const a = item as Record<string, unknown>;
    const text = typeof a.text === 'string' ? a.text : typeof a.content === 'string' ? a.content : '';
    const type = (['reply', 'react', 'search'] as const).find((t) => t === a.type) ?? 'send';
    if (!text) continue;
    const to = String(a.to ?? '').replace(/^#/, '').trim();
    out.push({ type, to: /^\d+$/.test(to) ? to : null, text });
  }
  return out;
}
