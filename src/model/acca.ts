/**
 * "Today's ACCA" and "Weekly Rollover" builders (pure functions, no bindings).
 * Input candidates are the latest value-filtered odds snapshots for upcoming
 * matches (assembled in the route from repo rows via latestPerCombo +
 * isValueRow). Combined products assume independence between legs — fine for
 * unrelated matches; noted wherever consumed.
 */

export interface AccaCandidate {
  match_id: number;
  match_league: string;
  utc_date: string;
  home_name: string;
  away_name: string;
  market: string;
  selection: string;
  line: number | null;
  best_odds: number;
  consensus_odds: number;
  bookmakers: number;
  model_prob: number;
  ev_pct: number;
}

export interface AccaLeg {
  matchId: number;
  league: string;
  utcDate: string;
  homeTeam: string;
  awayTeam: string;
  market: string;
  selection: string;
  line: number | null;
  modelProb: number;
  bestOdds: number;
  consensusOdds: number;
  bookmakers: number;
  evPct: number;
}

export interface CombinedAcca {
  combinedOdds: number;
  combinedProb: number;
  evPct: number;
}

const DAY_MS = 86_400_000;
const TODAY_HORIZON_MS = DAY_MS; // "today" = next 24h for the ACCA card
const MAX_LEGS = 4;
const ROLLOVER_MIN_PROB = 0.45;
// ACCA legs need real substance: at low probabilities the raw-EV sort is
// dominated by longshot noise (a 20% shot at 7.8 "beats" everything), and
// compounding 2-4 of those builds a card that looks +EV while being pure
// variance. Floor mirrors the rollover philosophy, relaxed one notch.
const ACCA_LEG_MIN_PROB = 0.3;

function toLeg(c: AccaCandidate): AccaLeg {
  return {
    matchId: c.match_id,
    league: c.match_league,
    utcDate: c.utc_date,
    homeTeam: c.home_name,
    awayTeam: c.away_name,
    market: c.market,
    selection: c.selection,
    line: c.line,
    modelProb: c.model_prob,
    bestOdds: c.best_odds,
    consensusOdds: c.consensus_odds,
    bookmakers: c.bookmakers,
    evPct: c.ev_pct,
  };
}

/**
 * Product of leg prices/probs. Independence assumption: legs are from
 * unrelated matches, so joint probability is the plain product.
 */
export function combineAcca(legs: { modelProb: number; bestOdds: number }[]): CombinedAcca {
  const combinedOdds = legs.reduce((a, l) => a * l.bestOdds, 1);
  const combinedProb = legs.reduce((a, l) => a * l.modelProb, 1);
  return { combinedOdds, combinedProb, evPct: legs.length === 0 ? 0 : combinedProb * combinedOdds - 1 };
}

export interface TodayAcca extends CombinedAcca {
  legs: AccaLeg[];
}

/**
 * Today's ACCA: highest-EV candidates from matches starting within the next
 * 24h, max one leg per match, top 4. Null when fewer than 2 legs (honest:
 * no card on dead days).
 */
export function buildTodayAcca(candidates: AccaCandidate[], nowIso: string): TodayAcca | null {
  const now = Date.parse(nowIso);
  const horizon = now + TODAY_HORIZON_MS;
  const pool = candidates
    .filter((c) => {
      const t = Date.parse(c.utc_date);
      return t >= now && t <= horizon && c.model_prob >= ACCA_LEG_MIN_PROB;
    })
    .sort((a, b) => b.ev_pct - a.ev_pct);
  const seenMatches = new Set<number>();
  const legs: AccaLeg[] = [];
  for (const c of pool) {
    if (seenMatches.has(c.match_id)) continue;
    seenMatches.add(c.match_id);
    legs.push(toLeg(c));
    if (legs.length === MAX_LEGS) break;
  }
  if (legs.length < 2) return null;
  return { legs, ...combineAcca(legs) };
}

export interface RolloverDay {
  date: string;
  leg: AccaLeg | null;
}

export interface RolloverPathPoint {
  date: string;
  cumulativeOdds: number;
  cumulativeProb: number;
}

export interface WeeklyRollover {
  days: RolloverDay[];
  path: RolloverPathPoint[];
}

/**
 * Weekly rollover: one high-confidence pick per UTC calendar day for the
 * next 7 days — the highest model_prob candidate of the day with
 * model_prob ≥ 0.45 (hit-rate strategy, not longshots; candidates already
 * passed the value filter). Days without a qualifying pick are null and are
 * skipped (not compounded) in the cumulative path.
 */
export function buildWeeklyRollover(candidates: AccaCandidate[], nowIso: string, dayCount = 7): WeeklyRollover {
  const now = Date.parse(nowIso);
  const startOfToday = Date.parse(`${nowIso.slice(0, 10)}T00:00:00Z`);
  const days: RolloverDay[] = [];
  const path: RolloverPathPoint[] = [];
  let cumOdds = 1;
  let cumProb = 1;
  for (let i = 0; i < dayCount; i++) {
    const dayStart = startOfToday + i * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const date = new Date(dayStart).toISOString().slice(0, 10);
    const best = candidates
      .filter((c) => {
        const t = Date.parse(c.utc_date);
        return t >= Math.max(now, dayStart) && t < dayEnd && c.model_prob >= ROLLOVER_MIN_PROB;
      })
      .sort((a, b) => b.model_prob - a.model_prob)[0];
    const leg = best ? toLeg(best) : null;
    days.push({ date, leg });
    if (leg) {
      cumOdds *= leg.bestOdds;
      cumProb *= leg.modelProb;
      path.push({ date, cumulativeOdds: cumOdds, cumulativeProb: cumProb });
    }
  }
  return { days, path };
}
