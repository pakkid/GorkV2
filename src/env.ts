import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_OWNER_ID: z.string().optional(),

  AI_API_KEY: z.string().min(1),
  AI_BASE_URL: z.url().optional(),
  // openrouter: OpenRouter or the Hack Club proxy. openai: any other OpenAI-compatible gateway
  AI_PROVIDER: z.enum(['openrouter', 'openai']).optional(),
  AI_MODEL: z.string().min(1).default('google/gemini-3-flash-preview'),
  AI_FALLBACK_MODELS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
    ),
  AI_REASONING: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATA_DIR: z.string().default('data'),
});

// treat `FOO=` in .env as unset so defaults apply
const raw = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== '')
);

const parsed = schema.safeParse(raw);
if (!parsed.success) {
  console.error('bad env:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

const data = parsed.data;
const provider =
  data.AI_PROVIDER ??
  (!data.AI_BASE_URL || /openrouter|hackclub/.test(data.AI_BASE_URL) ? 'openrouter' : 'openai');

export const env = { ...data, AI_PROVIDER: provider };
