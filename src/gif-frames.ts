import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from './log';

const log = logger('gif');

// gifs go to the model as one picture: this many frames from across the whole clip, in a grid.
// the still discord gives is just the first frame, and lots of gifs start on black
const COLS = 2;
const ROWS = 2;
const FRAMES = COLS * ROWS;
const WIDTH = 320;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 4_000_000;
// gif files are huge (several MB for a few seconds); the mp4 a gif embed carries is tiny
const MAX_DOWNLOAD = 20_000_000;
const DOWNLOAD_MS = 15_000;

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, TIMEOUT_MS);
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > MAX_BYTES) kill();
      else out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      err = (err + b).slice(-500);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited ${code}: ${err.trim()}`));
    });
  });
}

// checked once: without ffmpeg gork just gets discord's still
let available: Promise<boolean> | undefined;
function hasFfmpeg() {
  available ??= run('ffmpeg', ['-version'])
    .then(() => true)
    .catch(() => {
      log.warn('ffmpeg not found, gifs will only show their first frame');
      return false;
    });
  return available;
}

// the same gif shows up on every turn while it's in the recent chat; only cut it once
const cache = new Map<string, Promise<Uint8Array | undefined>>();

/**
 * A JPEG grid of frames spread over the gif/video at `url` (read left to right, top to
 * bottom), or undefined if it can't be done.
 */
export function gifFrames(url: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
  let hit = cache.get(url);
  if (!hit) {
    hit = cut(url, signal);
    cache.set(url, hit);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    // a failure from being interrupted shouldn't stick
    hit.then((r) => {
      if (!r) cache.delete(url);
    });
  }
  return hit;
}

/** Fetch it once to a temp file, so ffprobe and ffmpeg don't both download it. */
async function download(url: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(DOWNLOAD_MS);
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
  if (Number(res.headers.get('content-length')) > MAX_DOWNLOAD) throw new Error('too big');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_DOWNLOAD) throw new Error('too big');
    chunks.push(chunk);
  }
  const file = join(tmpdir(), `gork-gif-${randomUUID()}`);
  await writeFile(file, Buffer.concat(chunks));
  return file;
}

async function cut(url: string, signal?: AbortSignal) {
  if (!/^https:\/\//.test(url) || !(await hasFfmpeg())) return;
  const started = Date.now();
  let file: string | undefined;
  try {
    file = await download(url, signal);
    const probe = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      signal
    );
    const duration = Number.parseFloat(probe.toString()) || 2;
    // frames from the middle of each quarter, so frame one isn't the black intro
    const jpg = await run(
      'ffmpeg',
      [
        '-v', 'error',
        '-ss', (duration / FRAMES / 2).toFixed(3),
        '-i', file,
        '-vf', `fps=${FRAMES}/${duration.toFixed(3)},scale=${WIDTH}:-2,tile=${COLS}x${ROWS},format=yuvj420p`,
        '-frames:v', '1',
        '-q:v', '4',
        '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
      ],
      signal
    );
    if (!jpg.length) return;
    log.debug(`cut ${FRAMES} frames from a ${duration.toFixed(1)}s gif in ${Date.now() - started}ms`);
    return new Uint8Array(jpg);
  } catch (error) {
    log.debug(`couldn't cut frames from ${url}: ${(error as Error).message}`);
    return;
  } finally {
    if (file) void rm(file, { force: true });
  }
}
