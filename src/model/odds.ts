/**
 * Bookmaker-odds domain logic (pure functions): team-name normalization and
 * event↔fixture matching, overround removal, consensus/best aggregation,
 * EV math, value filters, and sport-title resolution. No bindings.
 */

/**
 * NFD + strip diacritics → lowercase → strip punctuation → drop trailing
 * fc/afc/cf → collapse whitespace. Diacritics stripping makes cross-source
 * matching work ("São Paulo FC" vs "Sao Paulo").
 */
export function normalizeTeamName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    // "Brighton & Hove Albion FC" (D1) vs "Brighton and Hove Albion" (odds):
    // drop standalone "and" so both reduce to the same tokens.
    .replace(/\band\b/g, " ")
    .replace(/\s+(fc|afc|cf)\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

export const MATCH_TIME_TOLERANCE_MS = 3 * 60 * 60 * 1000; // 3h

/**
 * Match an odds event to a D1 fixture: exact normalized home+away pair first,
 * then a contains-match fallback (either direction), and always require the
 * kickoff times to be within 3h. Returns null when nothing qualifies.
 */
export function matchEventToFixture(
  event: EventLike,
  fixtures: FixtureLike[],
  toleranceMs = MATCH_TIME_TOLERANCE_MS,
): FixtureLike | null {
  const eh = normalizeTeamName(event.home_team);
  const ea = normalizeTeamName(event.away_team);
  if (!eh || !ea) return null;
  const pairs = fixtures.map((f) => ({
    f,
    h: normalizeTeamName(f.homeTeamName),
    a: normalizeTeamName(f.awayTeamName),
  }));
  let candidates = pairs.filter((p) => p.h === eh && p.a === ea);
  if (candidates.length === 0) {
    const contains = (x: string, y: string) => x.includes(y) || y.includes(x);
    candidates = pairs.filter((p) => contains(p.h, eh) && contains(p.a, ea));
  }
  const within = candidates.filter(
    (p) => Math.abs(Date.parse(p.f.utcDate) - Date.parse(event.commence_time)) <= toleranceMs,
  );
  return within.length > 0 ? within[0].f : null;
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
