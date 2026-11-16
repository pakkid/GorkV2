// gork stays out of politics, and that's enforced here, not just asked for in the prompt:
// the model can be talked into "ok fine, one take", this list can't

const terms = [
  // the word itself
  'politic(?:s|al|ally|ian|ians)?', 'geopolitic(?:s|al)?',
  // elections and government
  'elections?', 'electoral', 'elect(?:ed)?', 'mp-elect', 'vot(?:e|es|ed|ing) for', 'referendum',
  'government', 'govt', 'parliament', 'beehive', 'senate', 'senators?', 'congress(?:man|woman)?',
  'prime minister', 'ministers?', 'president(?:s|ial)?', 'mayor', 'mps', 'mp',
  'cabinet minister', 'opposition leader', 'campaign(?:ing)? for',
  // parties and labels
  'labour party', 'national party', 'act party', 'green party', 'nz first', 'te p[aā]ti m[aā]ori',
  'democrats?', 'republicans?', 'gop', 'maga', 'tor(?:y|ies)', 'liberals?', 'conservatives?',
  'left[- ]wing(?:er)?', 'right[- ]wing(?:er)?', 'leftists?', 'lefties', 'far[- ](?:left|right)', 'alt[- ]right',
  'wokeness', 'woke (?:left|agenda|mob|mind virus)', 'communis[mt]s?', 'socialis[mt]s?', 'fascis[mt]s?', 'marxis[mt]s?', 'nazis?', 'zionis[mt]s?',
  // people
  'trump', 'biden', 'kamala', 'obama', 'vance', 'putin', 'kremlin', 'zelensk(?:y|yy|iy)', 'netanyahu',
  'xi jinping', 'ccp', 'modi', 'starmer', 'sunak', 'boris johnson', 'luxon', 'hipkins',
  'ardern', 'jacinda', 'seymour', 'winston peters', 'swarbrick', 'muralidhar',
  // issues
  'israel(?:i|is)?', 'palestin(?:e|ian|ians)', 'gaza', 'hamas', 'idf', 'ukrain(?:e|ian|ians)',
  'abortion', 'pro[- ]life', 'pro[- ]choice', 'immigra(?:tion|nts?)', 'refugees?', 'deport(?:ed|ation|ations)?',
  'brexit', 'tariffs?', 'sanctions', 'genocide', 'war crimes?', 'protest(?:s|ers)?',
  'treaty principles', 'co-governance', 'gun control', 'culture war',
];

const political = new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.join('|')})(?![\\p{L}\\p{N}])`, 'iu');

/** Whether a message is about politics. Accents don't help dodge it ("pāti" = "pati"). */
export function isPolitical(text: string) {
  return political.test(text.normalize('NFD').replace(/\p{M}/gu, '')) || political.test(text);
}

// what gork says instead, when someone pings him about it
const dodges = [
  'i aint talking political mate',
  'bro asked a discord bot for life advice',
  'my only opinion is lunch',
  'ask ur nan',
  'im legally a toaster i cant comment',
  'go outside and touch some grass first',
  'sorry i only discuss sausage sizzles',
  'not touching that with a ten foot pole',
  'this is above my pay grade and i get paid nothing',
  'lemme check with my lawyer. he says no',
  'cool story, anyway',
  'i was napping, what',
];

/** A flat no, different from the last ones he used. */
export function dodge(recent: string[]) {
  const fresh = dodges.filter((d) => !recent.includes(d));
  const pool = fresh.length ? fresh : dodges;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

export function isDodge(text: string) {
  return dodges.includes(text.toLowerCase().trim());
}
