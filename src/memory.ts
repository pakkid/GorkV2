import { notesPrompt, notesSystem } from './ai/prompt';
import { think } from './ai/think';
import { type ArchivedMsg, db } from './archive';
import { memory as cfg } from './config';
import { formatTime, untrusted } from './history';
import { logger } from './log';

const log = logger('memory');

// things gork decided were worth remembering, per server (or per DM)
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notes_scope ON notes (scope, id);
`);

export interface Note {
  id: number;
  text: string;
  created_at: number;
}

const insert = db.prepare('INSERT INTO notes (scope, text, created_at) VALUES (?, ?, ?)');
const dupe = db.prepare('SELECT 1 FROM notes WHERE scope = ? AND lower(text) = lower(?)');
const trim = db.prepare(`
  DELETE FROM notes WHERE scope = ? AND id NOT IN (
    SELECT id FROM notes WHERE scope = ? ORDER BY id DESC LIMIT ?
  )
`);
const latest = db.prepare('SELECT id, text, created_at FROM notes WHERE scope = ? ORDER BY id DESC LIMIT ?');
const removeOne = db.prepare('DELETE FROM notes WHERE scope = ? AND id = ?');
const removeAll = db.prepare('DELETE FROM notes WHERE scope = ?');

export function remember(scope: string, text: string) {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean || dupe.get(scope, clean)) return false;
  insert.run(scope, clean, Date.now());
  trim.run(scope, scope, cfg.maxNotes);
  log.info(`remembered in ${scope}: ${clean}`);
  return true;
}

export function forget(scope: string, id: number) {
  return removeOne.run(scope, id).changes > 0;
}

export function forgetAll(scope: string) {
  return Number(removeAll.run(scope).changes);
}

const editStmt = db.prepare('UPDATE notes SET text = ? WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM notes WHERE id = ?');
const scopesStmt = db.prepare('SELECT scope, COUNT(*) n FROM notes GROUP BY scope');

/** Change a note's text by id (web ui). */
export function editNote(id: number, text: string) {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return false;
  return editStmt.run(clean, id).changes > 0;
}

export function deleteNote(id: number) {
  return deleteStmt.run(id).changes > 0;
}

/** Every scope that has notes, with how many. */
export function noteScopes() {
  return scopesStmt.all() as { scope: string; n: number }[];
}

/** Newest notes, oldest first so they read like a timeline. */
export function notes(scope: string, limit = cfg.inPrompt) {
  return (latest.all(scope, limit) as unknown as Note[]).reverse();
}

/**
 * Throw away the notes and write new ones by having gork reread the chat, oldest first,
 * so newer facts overwrite older ones.
 */
export async function rebuildNotes(
  scope: string,
  guildId: string | null,
  msgs: ArchivedMsg[],
  channelName: (id: string) => string,
  onProgress?: (part: number, parts: number) => void
) {
  forgetAll(scope);
  const chunks: string[] = [];
  let lines: string[] = [];
  let size = 0;
  for (const m of msgs) {
    const line = `[${formatTime(m.created_at, true)} ${new Date(m.created_at).getFullYear()} #${channelName(m.channel_id)}] ${untrusted(m.author)}: ${untrusted(m.body.slice(0, 500))}`;
    if (size + line.length > cfg.rebuildChunkChars && lines.length) {
      chunks.push(lines.join('\n'));
      lines = [];
      size = 0;
    }
    lines.push(line);
    size += line.length + 1;
  }
  if (lines.length) chunks.push(lines.join('\n'));

  for (const [i, chat] of chunks.entries()) {
    onProgress?.(i + 1, chunks.length);
    const prompt = notesPrompt({ notes: notes(scope, cfg.maxNotes), chat, part: i + 1, parts: chunks.length });
    try {
      for await (const action of think({ system: notesSystem, prompt, images: [], where: { kind: 'notes', guildId } })) {
        if (action.type === 'remember') remember(scope, action.text);
        else if (action.type === 'forget' && action.to) forget(scope, Number(action.to));
      }
    } catch (error) {
      log.warn(`notes rebuild part ${i + 1} failed`, error);
    }
  }
  return notes(scope, cfg.maxNotes).length;
}
