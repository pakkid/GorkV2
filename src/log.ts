import { env } from './env';

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

const min = levels[env.LOG_LEVEL];

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (levels[level] < min) return;
  const time = new Date().toISOString().slice(11, 23);
  const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra instanceof Error ? extra.message : extra);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
  };
}
