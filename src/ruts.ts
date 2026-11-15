import type { ChatMsg } from './history';

// gork's own messages looked at when hunting for worn-out bits
const WINDOW = 20;
// a word/phrase in this many of them is a rut
const MIN_USES = 3;
// ...and at this many, a chime-in that leans on it gets dropped outright
const HARD_USES = 6;

const stop = new Set(
  (
    'a an the and or but if so to of in on at by for with from up down out over into onto off ' +
    'is are was were be been being am im i me my mine you u ur your youre yours he she it its they them their ' +
    'we us our this that these those there here what who whom which when where why how ' +
    'not no yes yeah ya just got get gets getting now then than too very still even only also ' +
    'do does did done dont doesnt didnt cant wont aint can will would could should have has had ' +
    'all any some more most much many one ones like lol lmao lmfao fr bro'
  ).split(' ')
);

/** Crude stem so "void", "voided", "voids", "void's" all count as one bit. */
function stem(word: string) {
  let w = word.replace(/['’]s$/, '').replace(/['’]/g, '');
  for (const suffix of ['ing', 'ed', 'es', 's', 'e']) {
    if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

function words(text: string) {
  return text
    .toLowerCase()
    .replace(/<@!?\d+>|https?:\S+/g, ' ')
    .split(/[^\p{L}\p{N}'’]+/u)
    .filter(Boolean);
}

interface Bit {
  // how gork actually wrote it, for the prompt
  shown: string;
  key: string;
  uses: number;
}

export interface Ruts {
  bits: Bit[];
  // first words gork keeps opening with ("ur", "bro")
  openers: string[];
  /** Whether a message leans on something gork has said to death. */
  isTired(text: string): boolean;
  /** Drops a leading "sheep" / "sheep mate," — it's a reply, they know it's for them. */
  dropName(text: string): string;
}

// how many of gork's last messages count when checking openers, and how many may share one
const OPENER_WINDOW = 10;
const OPENER_MAX = 2;

// what tends to ride along right after a name: "sheep mate", "blancmange lil bro"
const vocative = /^(?:(?:mate|bro|bruh|brah|dude|man|dawg|fam|bestie|lil bro|my guy|buddy|pal|sir|son)\b[\s,.:!-]*)+/i;

/**
 * Words and two-word phrases gork keeps reusing that the chat itself isn't saying.
 * Exact-repeat checks miss "ur gpu got voided" -> "ur bounce got voided harder";
 * this catches the bit underneath.
 */
export function findRuts(messages: ChatMsg[]): Ruts {
  const live = messages.filter((m) => !m.deleted);
  const mine = live.filter((m) => m.self).slice(-WINDOW);
  const theirs = live.filter((m) => !m.self).slice(-WINDOW * 2);

  // people's names aren't a bit, gork is just talking to them
  const names = new Set<string>();
  for (const m of live) {
    for (const n of [m.name, m.globalName, m.username]) {
      for (const w of words(n ?? '')) {
        names.add(stem(w));
        // "Sheep26" gets called "sheep"
        names.add(stem(w.replace(/[\d_]+$/, '')));
      }
    }
  }

  // whole name words, for spotting gork addressing someone by name
  const nameWords = new Set<string>();
  for (const m of live) {
    if (m.self) continue;
    for (const n of [m.name, m.globalName, m.username]) {
      for (const w of words(n ?? '')) {
        for (const v of [w, w.replace(/[\d_]+$/, '')]) {
          if (v.length >= 3 && !stop.has(v)) nameWords.add(v);
        }
      }
    }
  }

  const dropName = (text: string) => {
    let out = text.trimStart();
    // a few rounds: "sheep blancmange ur..." or "@Sheep26 mate ur..."
    for (let i = 0; i < 3; i++) {
      const m = out.match(/^@?([\p{L}\p{N}_.]+)[\s,.:!-]+/u);
      if (!m) break;
      const w = m[1]!.toLowerCase();
      if (!nameWords.has(w) && !nameWords.has(w.replace(/[\d_]+$/, ''))) break;
      const rest = out.slice(m[0].length).replace(vocative, '');
      if (!rest.trim()) break;
      out = rest;
    }
    return out;
  };

  const keysOf = (text: string) => {
    const ws = words(text);
    const keys = new Map<string, string>();
    ws.forEach((w, i) => {
      const s = stem(w);
      if (!stop.has(w) && !names.has(s) && s.length >= 3) keys.set(s, w);
      const next = ws[i + 1];
      // phrases, as long as one half carries meaning ("harder than", "spam bucket")
      if (next && (!stop.has(w) || !stop.has(next)) && !names.has(s) && !names.has(stem(next))) {
        keys.set(`${s} ${stem(next)}`, `${w} ${next}`);
      }
    });
    return keys;
  };

  const counts = new Map<string, Bit>();
  for (const m of mine) {
    for (const [key, shown] of keysOf(m.content)) {
      const bit = counts.get(key) ?? { key, shown, uses: 0 };
      bit.uses++;
      counts.set(key, bit);
    }
  }

  const chat = new Map<string, number>();
  for (const m of theirs) {
    for (const key of keysOf(m.content).keys()) chat.set(key, (chat.get(key) ?? 0) + 1);
  }

  let bits = [...counts.values()].filter(
    // if the chat keeps saying it too, it's the topic, not a tic
    (b) => b.uses >= MIN_USES && (chat.get(b.key) ?? 0) * 2 < b.uses
  );
  // a phrase made of words already listed adds nothing
  const single = new Set(bits.filter((b) => !b.key.includes(' ')).map((b) => b.key));
  bits = bits
    .filter((b) => !b.key.includes(' ') || !b.key.split(' ').every((k) => single.has(k) || stop.has(k)))
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 12);

  const firsts = new Map<string, number>();
  for (const m of mine.slice(-OPENER_WINDOW)) {
    const first = words(dropName(m.content))[0];
    if (first) firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  const openers = [...firsts].filter(([, n]) => n > OPENER_MAX).map(([w]) => w);

  const hard = bits.filter((b) => b.uses >= HARD_USES).map((b) => b.key);
  return {
    bits,
    openers,
    dropName,
    isTired(text) {
      if (!hard.length) return false;
      const ws = words(text).map(stem);
      const phrases = new Set(ws.slice(1).map((w, i) => `${ws[i]} ${w}`));
      return hard.some((k) => (k.includes(' ') ? phrases.has(k) : ws.includes(k)));
    },
  };
}
