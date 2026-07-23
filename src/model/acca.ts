/**
 * "Today's ACCA" (v2: highest-probability leg per match across 1X2, double
 * chance, totals and BTTS, with market/derived/model pricing tiers) and
 * "Weekly Rollover" (snapshot-based, unchanged). Pure functions, no bindings.
 * Combined products assume independence between legs — fine for unrelated
 * matches; noted wherever consumed.
 */

import type { Markets } from "./markets";
import { fairImplied } from "./odds";

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

const DAY_MS = 86_400_000;
const ROLLOVER_MIN_PROB = 0.45;

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

/* ================= ACCA v2: highest-probability legs across markets ================= */

/** One snapshot outcome's aggregated prices for a match. */
export interface SnapOutcome {
  best: number;
  consensus: number;
  bookmakers: number;
}

/** Latest h2h + totals snapshot for one match (nullable pieces). */
export interface MatchSnapshot {
  h2h: Partial<Record<"home" | "draw" | "away", SnapOutcome>>;
  /** key `${selection}|${line}` e.g. "over|2.5" */
  totals: Map<string, SnapOutcome>;
}

export type PriceKind = "market" | "derived" | "model";

export interface MenuLeg {
  market: string;
  selection: string;
  line: number | null;
  modelProb: number;
  price: number;
  priceKind: PriceKind;
  evPct: number | null;
}

/**
 * Derived double-chance prices from the match's CONSENSUS 1X2 prices:
 * margin-normalize (fairImplied), then 1X = 1/(pH+pD) etc. These are
 * ESTIMATES computed from quoted 1X2 prices, not bookmaker-quoted DC prices.
 */
export function dcPricesFromH2h(pricesH: number, pricesD: number, pricesA: number): { o1X: number; oX2: number; o12: number } {
  const [pH, pD, pA] = fairImplied([pricesH, pricesD, pricesA]);
  const safe = (p: number) => (p > 0 ? 1 / p : 0);
  return { o1X: safe(pH + pD), oX2: safe(pA + pD), o12: safe(pH + pA) };
}

/**
 * All candidate legs for one match: market-priced (h2h + synced totals from
 * the snapshot), derived (double chance from consensus 1X2), and model-only
 * (BTTS + every O/U line both sides at the model fair price 1/p — marked
 * "model", never used in EV math).
 */
export function legMenu(gridMarkets: Markets, snap: MatchSnapshot | null): MenuLeg[] {
  const legs: MenuLeg[] = [];
  const grid1x2: Record<string, number> = {
    home: gridMarkets.homeWin,
    draw: gridMarkets.draw,
    away: gridMarkets.awayWin,
  };

  if (snap) {
    for (const sel of ["home", "draw", "away"] as const) {
      const o = snap.h2h[sel];
      if (!o) continue;
      legs.push({
        market: "h2h",
        selection: sel,
        line: null,
        modelProb: grid1x2[sel],
        price: o.best,
        priceKind: "market",
        evPct: grid1x2[sel] * o.best - 1,
      });
    }
    const h = snap.h2h.home;
    const d = snap.h2h.draw;
    const a = snap.h2h.away;
    if (h && d && a) {
      const dc = dcPricesFromH2h(h.consensus, d.consensus, a.consensus);
      const dcLegs: [string, number, number][] = [
        ["1X", gridMarkets.doubleChance.homeOrDraw, dc.o1X],
        ["X2", gridMarkets.doubleChance.awayOrDraw, dc.oX2],
        ["12", gridMarkets.doubleChance.homeOrAway, dc.o12],
      ];
      for (const [sel, prob, price] of dcLegs) {
        legs.push({ market: "doubleChance", selection: sel, line: null, modelProb: prob, price, priceKind: "derived", evPct: prob * price - 1 });
      }
    }
    for (const [key, o] of snap.totals) {
      const [sel, lineS] = key.split("|");
      const line = Number(lineS);
      const lineObj = gridMarkets.overUnder.find((l) => l.line === line);
      if (!lineObj) continue;
      const prob = sel === "over" ? lineObj.over : lineObj.under;
      legs.push({ market: "totals", selection: sel, line, modelProb: prob, price: o.best, priceKind: "market", evPct: prob * o.best - 1 });
    }
  }

  // Model-only legs: BTTS + every line both sides at the model fair price.
  legs.push({ market: "btts", selection: "yes", line: null, modelProb: gridMarkets.bttsYes, price: 1 / gridMarkets.bttsYes, priceKind: "model", evPct: null });
  legs.push({ market: "btts", selection: "no", line: null, modelProb: gridMarkets.bttsNo, price: 1 / gridMarkets.bttsNo, priceKind: "model", evPct: null });
  for (const l of gridMarkets.overUnder) {
    legs.push({ market: "totals", selection: "over", line: l.line, modelProb: l.over, price: 1 / l.over, priceKind: "model", evPct: null });
    legs.push({ market: "totals", selection: "under", line: l.line, modelProb: l.under, price: 1 / l.under, priceKind: "model", evPct: null });
  }
  return legs;
}

export interface PickFloors {
  minProb: number;
  minEv: number;
}

export const ACCA_V2_FLOORS: PickFloors = { minProb: 0.55, minEv: -0.03 };

const KIND_RANK: Record<PriceKind, number> = { market: 0, derived: 1, model: 2 };

/**
 * The single highest-probability favorable outcome for a match: legs with
 * modelProb ≥ 0.55 and (unpriced OR evPct ≥ −0.03), highest modelProb wins;
 * tie-break higher evPct (unpriced counts lowest), then market > derived > model.
 */
export function pickBestLeg(menu: MenuLeg[], floors: PickFloors = ACCA_V2_FLOORS): MenuLeg | null {
  const eligible = menu.filter((l) => l.modelProb >= floors.minProb && (l.evPct === null || l.evPct >= floors.minEv));
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => {
    if (b.modelProb !== a.modelProb) return b.modelProb - a.modelProb;
    const evA = a.evPct ?? Number.NEGATIVE_INFINITY;
    const evB = b.evPct ?? Number.NEGATIVE_INFINITY;
    if (evB !== evA) return evB - evA;
    return KIND_RANK[a.priceKind] - KIND_RANK[b.priceKind];
  })[0];
}

export interface AccaV2Leg extends MenuLeg {
  matchId: number;
  league: string;
  utcDate: string;
  homeTeam: string;
  awayTeam: string;
}

export interface MatchMeta {
  matchId: number;
  league: string;
  utcDate: string;
  homeTeam: string;
  awayTeam: string;
}

export interface TodayAccaV2 {
  legs: AccaV2Leg[];
  combinedOdds: number;
  combinedProb: number;
  /** Π(modelProb×price) over market+derived legs − 1; null when no priced legs. */
  evPct: number | null;
  modelLegs: number;
}

/**
 * Assemble the card from the per-match picks: up to 4 matches ranked by
 * their leg's modelProb (min 2). combinedOdds/Prob multiply ALL legs (model
 * legs included at their fair price); evPct compounds only market+derived legs.
 */
export function buildTodayAccaV2(picked: { match: MatchMeta; leg: MenuLeg }[]): TodayAccaV2 | null {
  const top = [...picked].sort((a, b) => b.leg.modelProb - a.leg.modelProb).slice(0, 4);
  if (top.length < 2) return null;
  const legs: AccaV2Leg[] = top.map(({ match, leg }) => ({
    ...leg,
    matchId: match.matchId,
    league: match.league,
    utcDate: match.utcDate,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
  }));
  const combinedOdds = legs.reduce((a, l) => a * l.price, 1);
  const combinedProb = legs.reduce((a, l) => a * l.modelProb, 1);
  const priced = legs.filter((l) => l.priceKind !== "model");
  const evPct = priced.length > 0 ? priced.reduce((a, l) => a * (l.modelProb * l.price), 1) - 1 : null;
  return { legs, combinedOdds, combinedProb, evPct, modelLegs: legs.length - priced.length };
}
