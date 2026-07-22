/**
 * Bookmaker-odds domain logic (pure functions): team-name normalization and
 * event↔fixture matching, overround removal, consensus/best aggregation,
 * EV math, value filters, and sport-title resolution. No bindings.
 */

/**
 * Club-designator tokens stripped anywhere in a name (exact token match only).
 * Cross-source names differ mostly by these: "FC Augsburg" vs "Augsburg",
 * "Olympique de Marseille" vs "Marseille", "VfB Stuttgart" vs "Stuttgart".
 */
const CLUB_TOKENS = new Set([
  "fc", "afc", "acf", "cf", "bc", "sc", "ac", "as", "sv", "ss", "rc", "ca", "cd", "ud", "bk", "fk", "sk", "nk",
  "vfb", "vfl", "tsg", "us", "es", "sco", "osc", "stade", "club", "deportivo", "olympique", "calcio", "de",
  "la", "di",
]);

/** Stubborn same-club spellings that prefix-fuzzy can't bridge (exonyms). */
const TOKEN_ALIASES = new Map<string, string>([
  ["rennes", "rennais"],
  ["munich", "munchen"],
  ["cologne", "koln"],
  ["seville", "sevilla"],
]);

/**
 * NFD + strip diacritics → lowercase → strip punctuation → drop "and" →
 * remove club-designator tokens → collapse whitespace. Diacritics stripping
 * makes cross-source matching work ("São Paulo FC" vs "Sao Paulo",
 * "Bayern München" vs "Bayern Munchen").
 */
export function normalizeTeamName(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    // "Brighton & Hove Albion FC" (D1) vs "Brighton and Hove Albion" (odds):
    // drop standalone "and" so both reduce to the same tokens.
    .replace(/\band\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base
    .split(" ")
    .filter((t) => t.length > 0 && !CLUB_TOKENS.has(t))
    .map((t) => TOKEN_ALIASES.get(t) ?? t)
    .join(" ");
}

/** Exact, or prefix of the other when the shorter token has >= 4 chars
 *  ("lyon"~"lyonnais", "milan"~"milano", "munich"~"munchen", "inter"~"internazionale"). */
function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 4 && l.startsWith(s);
}

/**
 * Do two team names refer to the same club? The smaller token set must be
 * fully explained by the larger one under tokenMatch ("PEC Zwolle" ⊇
 * "Zwolle", "Stade Brestois 29" ⊇ "Brest" via brest~brestois).
 */
export function teamNamesAlign(a: string, b: string): boolean {
  const ta = normalizeTeamName(a).split(" ").filter(Boolean);
  const tb = normalizeTeamName(b).split(" ").filter(Boolean);
  if (ta.length === 0 || tb.length === 0) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return small.every((t) => big.some((u) => tokenMatch(t, u)));
}

export interface FixtureLike {
  id: number;
  utcDate: string;
  homeTeamName: string;
  awayTeamName: string;
}

export interface EventLike {
  id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
}

/**
 * Kickoff tolerance for event↔fixture pairing. football-data.org sets
 * placeholder times (whole matchday at 15:00Z) until schedules are confirmed,
 * while bookmakers price real staggered kickoffs — so the window must span
 * days, not hours. Within one league the same pair never plays twice in 72h,
 * and the nearest-time tiebreak guards the theoretical edge case.
 */
export const MATCH_TIME_TOLERANCE_MS = 72 * 60 * 60 * 1000; // 72h

/**
 * Match an odds event to a D1 fixture. A (home, away) pair occurs at most once
 * per league season, so a UNIQUE exact/aligned pairing is accepted even when
 * the two sources disagree on the date by days (football-data.org keeps
 * placeholder dates on unconfirmed fixtures). With multiple aligned
 * candidates (duplicated fixture data), only those within 72h compete:
 * fewest extra tokens, then nearest in time. Null when nothing qualifies.
 */
export function matchEventToFixture(
  event: EventLike,
  fixtures: FixtureLike[],
  toleranceMs = MATCH_TIME_TOLERANCE_MS,
): FixtureLike | null {
  const eh = normalizeTeamName(event.home_team);
  const ea = normalizeTeamName(event.away_team);
  if (!eh || !ea) return null;
  const eventMs = Date.parse(event.commence_time);
  const exact: { f: FixtureLike; dt: number }[] = [];
  const aligned: { f: FixtureLike; delta: number; dt: number }[] = [];
  for (const f of fixtures) {
    const dt = Math.abs(Date.parse(f.utcDate) - eventMs);
    const fh = normalizeTeamName(f.homeTeamName);
    const fa = normalizeTeamName(f.awayTeamName);
    if (fh === eh && fa === ea) {
      exact.push({ f, dt });
    } else if (
      teamNamesAlign(event.home_team, f.homeTeamName) &&
      teamNamesAlign(event.away_team, f.awayTeamName)
    ) {
      const delta =
        Math.abs(fh.split(" ").length - eh.split(" ").length) + Math.abs(fa.split(" ").length - ea.split(" ").length);
      aligned.push({ f, delta, dt });
    }
  }
  if (exact.length > 0) {
    exact.sort((x, y) => x.dt - y.dt);
    return exact[0].f;
  }
  if (aligned.length === 1) return aligned[0].f;
  if (aligned.length > 1) {
    const within = aligned
      .filter((c) => c.dt <= toleranceMs)
      .sort((x, y) => x.delta - y.delta || x.dt - y.dt);
    return within.length > 0 ? within[0].f : null;
  }
  return null;
}

/** Some feeds emit duplicate events for one match — keep the one with the most bookmakers. */
export function dedupeEvents<T extends EventLike & { bookmakers?: unknown[] }>(events: T[]): T[] {
  const best = new Map<string, T>();
  for (const e of events) {
    const key = `${normalizeTeamName(e.home_team)}|${normalizeTeamName(e.away_team)}`;
    const prev = best.get(key);
    if (!prev || (e.bookmakers?.length ?? 0) > (prev.bookmakers?.length ?? 0)) best.set(key, e);
  }
  return [...best.values()];
}

/** Overround removal: fair implied probabilities from decimal prices. */
export function fairImplied(prices: number[]): number[] {
  const implied = prices.map((p) => (p > 0 ? 1 / p : 0));
  const sum = implied.reduce((a, b) => a + b, 0);
  if (sum <= 0) return prices.map(() => 0);
  return implied.map((i) => i / sum);
}

export interface OddsAggregate {
  best: number;
  consensus: number;
  bookmakers: number;
}

/** Aggregate one outcome's prices across bookmakers: max, mean, count. */
export function aggregatePrices(prices: number[]): OddsAggregate {
  const valid = prices.filter((p) => Number.isFinite(p) && p > 1);
  if (valid.length === 0) return { best: 0, consensus: 0, bookmakers: 0 };
  return {
    best: Math.max(...valid),
    consensus: valid.reduce((a, b) => a + b, 0) / valid.length,
    bookmakers: valid.length,
  };
}

/** EV of taking the best available price against the model probability. */
export function evPct(modelProb: number, bestOdds: number): number {
  return modelProb * bestOdds - 1;
}

export interface ValueFilter {
  minEv?: number;
  minProb?: number;
  minBooks?: number;
}

export interface ValueCandidate {
  model_prob: number;
  ev_pct: number;
  bookmakers: number;
}

export function isValueRow(row: ValueCandidate, filter: ValueFilter = {}): boolean {
  const { minEv = 0.04, minProb = 0.15, minBooks = 3 } = filter;
  return row.ev_pct >= minEv && row.model_prob >= minProb && row.bookmakers >= minBooks;
}

/** P(home + away goals > line) straight from a score grid. */
export function gridProbTotalOver(grid: number[][], line: number): number {
  let over = 0;
  for (let x = 0; x < grid.length; x++) {
    for (let y = 0; y < grid[x].length; y++) {
      if (x + y > line) over += grid[x][y];
    }
  }
  return over;
}

/** Latest row per (match, market, selection, line) by fetched_at. */
export function latestPerCombo<
  T extends { match_id: number; market: string; selection: string; line?: number | null; fetched_at: string },
>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const key = `${r.match_id}|${r.market}|${r.selection}|${r.line ?? ""}`;
    const prev = best.get(key);
    if (!prev || r.fetched_at > prev.fetched_at) best.set(key, r);
  }
  return [...best.values()];
}

export interface SportLike {
  key: string;
  title: string;
}

/**
 * Resolve one of our league names (e.g. "Premier League") to a sport key from
 * /sports by title. Prefers exact normalized equality, then the shortest
 * title that contains (or is contained by) the league name. Null when no
 * plausible match — sport keys change, never guess them.
 */
export function resolveSportByTitle(leagueName: string, sports: SportLike[]): SportLike | null {
  const want = normalizeTeamName(leagueName);
  if (!want) return null;
  const normalized = sports
    .map((s) => ({ s, t: normalizeTeamName(s.title) }))
    .filter((p) => p.t.length > 0);
  const exact = normalized.find((p) => p.t === want);
  if (exact) return exact.s;
  const contains = normalized
    .filter((p) => p.t.includes(want) || want.includes(p.t))
    .sort((a, b) => a.t.length - b.t.length);
  return contains.length > 0 ? contains[0].s : null;
}
