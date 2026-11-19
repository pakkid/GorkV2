import type { OwnerRules } from './ai/prompt';

// runs of this many words copied from the owner's text count as reading it out
const RUN = 5;

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

// him talking about being set up, which gives the game away whatever the topic
const tells =
  /\b(my|the) (owner|creator|dev|developer)s? (told|said|wants|made|set|programmed|instructed)\b|\b(i was|im|i am|i got|ive been|i've been) (told|programmed|instructed|set up|configured|prompted) to\b|\bmy (instructions|prompt|system prompt|programming|settings|rules|owner instructions|taste list)\b|\bowner.instructions\b|\byour-taste\b/i;

/**
 * Catches gork reading out what the owner wrote (opinions, instructions, modifiers) or
 * saying he was told to act some way. `chat` is the transcript: a phrase someone in chat
 * already said isn't a leak, even if the owner used it too.
 */
export function leakChecker(rules: OwnerRules, chat: string) {
  const runs = new Set<string>();
  for (const text of [...rules.modifiers, ...rules.instructions, ...(rules.opinions ?? [])]) {
    const w = words(text);
    for (let i = 0; i + RUN <= w.length; i++) runs.add(w.slice(i, i + RUN).join(' '));
  }
  const said = ` ${words(chat).join(' ')} `;
  return (text: string) => {
    if (tells.test(text.replace(/[’']/g, ''))) return true;
    const w = words(text);
    for (let i = 0; i + RUN <= w.length; i++) {
      const run = w.slice(i, i + RUN).join(' ');
      if (runs.has(run) && !said.includes(` ${run} `)) return true;
    }
    return false;
  };
}
