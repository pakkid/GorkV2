import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { SharedV4ProviderOptions } from '@ai-sdk/provider';
import { type LanguageModel, Output, streamText, type UserContent } from 'ai';
import { z } from 'zod';
import { timing } from '../config';
import { env } from '../env';
import { logger } from '../log';

const log = logger('think');

// the json shape is spelled out in the prompt, so "no structured outputs" warnings are noise
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

const models = [env.AI_MODEL, ...env.AI_FALLBACK_MODELS];

let modelFor: (id: string) => LanguageModel;
let providerOptions: SharedV4ProviderOptions = {};

if (env.AI_PROVIDER === 'openrouter') {
  const openrouter = createOpenRouter({ apiKey: env.AI_API_KEY, baseURL: env.AI_BASE_URL });
  modelFor = (id) => openrouter.chat(id);
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
  type: z.enum(['reply', 'send', 'search', 'remember', 'forget']),
  // a string: discord ids are too big for a js number
  to: z
    .string()
    .nullable()
    .describe('message id to reply to (reply), memory note number (forget), null otherwise'),
  text: z
    .string()
    .describe('the message text, the keywords to search for, or the note to remember'),
});

export type Action = z.infer<typeof actionSchema>;

export interface ThinkInput {
  system: string;
  prompt: string;
  images: { url: string; id: string }[];
  signal?: AbortSignal;
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

    if (input.signal?.aborted) return;
    // an abort from our own timeout ends the stream quietly, so it has to be called out
    if (timeout.aborted) failure ??= new Error(`timed out after ${timing.timeoutMs / 1000}s`);

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
    const type = (['reply', 'search', 'remember', 'forget'] as const).find((t) => t === a.type) ?? 'send';
    if (!text && type !== 'forget') continue;
    const to = String(a.to ?? '').replace(/^#/, '').trim();
    out.push({ type, to: /^\d+$/.test(to) ? to : null, text });
  }
  return out;
}
