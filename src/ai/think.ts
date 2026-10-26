import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { Output, streamText, type UserContent } from 'ai';
import { z } from 'zod';
import { timing } from '../config';
import { env } from '../env';
import { logger } from '../log';

const log = logger('think');

const openrouter = createOpenRouter({
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
});

const models = [env.AI_MODEL, ...env.AI_FALLBACK_MODELS];

const reasoning =
  env.AI_REASONING === 'none'
    ? { enabled: false }
    : { effort: env.AI_REASONING };

// flat + nullable instead of a union so strict json-schema providers accept it
export const actionSchema = z.object({
  type: z.enum(['reply', 'send', 'search']),
  to: z
    .number()
    .int()
    .nullable()
    .describe('transcript #number of the target message (reply), null for send'),
  text: z
    .string()
    .describe('the message text, or the keywords to search for'),
});

export type Action = z.infer<typeof actionSchema>;

export interface ThinkInput {
  system: string;
  prompt: string;
  images: { url: string; ref: number }[];
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
    content.push({ type: 'text', text: `(image from #${img.ref})` });
    content.push({ type: 'image', image: new URL(img.url) });
  }

  for (const [i, model] of models.entries()) {
    const started = Date.now();
    let emitted = 0;
    let failure: unknown;

    const result = streamText({
      model: openrouter.chat(model),
      system: input.system,
      messages: [{ role: 'user', content }],
      output: Output.array({ element: actionSchema, maxItems: 8 }),
      temperature: 0.9,
      maxRetries: 0,
      abortSignal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(timing.timeoutMs)])
        : AbortSignal.timeout(timing.timeoutMs),
      providerOptions: { openrouter: { reasoning } },
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
