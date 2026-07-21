/**
 * Bet tracker domain logic (pure functions): market evaluation against a
 * final score, settlement profit math, and summary aggregation.
 */

import type { BetRow } from "../types";

export type BetResult = "won" | "lost" | "void";

/**
 * Evaluate a bet against a final score. Returns won/lost/void, or null when
 * the market/selection is unsupported (caller reports it as skipped).
 * Exact-line landings on overUnder push to void.
 */
export function evaluateBet(
  market: string,
  selection: string,
  line: number | null,
  homeGoals: number,
  awayGoals: number,
): BetResult | null {
  const sel = selection.trim().toLowerCase();
  switch (market) {
    case "1X2": {
      if (sel === "home") return homeGoals > awayGoals ? "won" : "lost";
      if (sel === "draw") return homeGoals === awayGoals ? "won" : "lost";
      if (sel === "away") return homeGoals < awayGoals ? "won" : "lost";
      return null;
    }
    case "doubleChance": {
      if (sel === "1x") return homeGoals >= awayGoals ? "won" : "lost";
      if (sel === "x2") return homeGoals <= awayGoals ? "won" : "lost";
      if (sel === "12") return homeGoals !== awayGoals ? "won" : "lost";
      return null;
    }
    case "overUnder": {
      if (line === null || !Number.isFinite(line)) return null;
      const total = homeGoals + awayGoals;
      if (total === line) return "void";
      if (sel === "over") return total > line ? "won" : "lost";
      if (sel === "under") return total < line ? "won" : "lost";
      return null;
    }
    case "btts": {
      const both = homeGoals >= 1 && awayGoals >= 1;
      if (sel === "yes") return both ? "won" : "lost";
      if (sel === "no") return both ? "lost" : "won";
      return null;
    }
    default:
      return null;
  }
}

/** Settlement profit, rounded to cents. */
export function settleProfit(result: BetResult, odds: number, stake: number): number {
  const raw = result === "won" ? stake * (odds - 1) : result === "lost" ? -stake : 0;
  return Math.round(raw * 100) / 100;
}

export interface BetStatusCounts {
  open: number;
  won: number;
  lost: number;
  void: number;
}

export interface BetBreakdownRow {
  key: string;
  bets: number;
  staked: number;
  profit: number;
  roiPct: number | null;
}

export interface BetSummary {
  counts: BetStatusCounts;
  /** Stake actually resolved (won+lost+void). */
  staked: number;
  /** Stake still riding on open bets. */
  openStaked: number;
  profit: number;
  /** profit / staked * 100 over settled bets; null when nothing settled. */
  roiPct: number | null;
  /** won / (won + lost); null when no decided bets. */
  strikeRate: number | null;
  byBookmaker: BetBreakdownRow[];
  byMarket: BetBreakdownRow[];
}

function breakdown(rows: BetRow[], keyOf: (b: BetRow) => string): BetBreakdownRow[] {
  const acc = new Map<string, { bets: number; staked: number; profit: number }>();
  for (const b of rows) {
    const key = keyOf(b);
    const entry = acc.get(key) ?? { bets: 0, staked: 0, profit: 0 };
    entry.bets++;
    entry.staked += b.stake;
    entry.profit += b.profit ?? 0;
    acc.set(key, entry);
  }
  return [...acc.entries()]
    .map(([key, e]) => ({
      key,
      bets: e.bets,
      staked: Math.round(e.staked * 100) / 100,
      profit: Math.round(e.profit * 100) / 100,
      roiPct: e.staked > 0 ? Math.round((e.profit / e.staked) * 10000) / 100 : null,
    }))
    .sort((a, b) => b.staked - a.staked);
}

/** Aggregate a list of bets (any statuses) into headline totals + breakdowns. */
export function summarizeBets(rows: BetRow[]): BetSummary {
  const counts: BetStatusCounts = { open: 0, won: 0, lost: 0, void: 0 };
  let openStaked = 0;
  const settled: BetRow[] = [];
  for (const b of rows) {
    if (b.status === "open") {
      counts.open++;
      openStaked += b.stake;
    } else {
      if (b.status === "won") counts.won++;
      else if (b.status === "lost") counts.lost++;
      else if (b.status === "void") counts.void++;
      settled.push(b);
    }
  }
  const staked = settled.reduce((a, b) => a + b.stake, 0);
  const profit = settled.reduce((a, b) => a + (b.profit ?? 0), 0);
  const decided = counts.won + counts.lost;
  return {
    counts,
    staked: Math.round(staked * 100) / 100,
    openStaked: Math.round(openStaked * 100) / 100,
    profit: Math.round(profit * 100) / 100,
    roiPct: staked > 0 ? Math.round((profit / staked) * 10000) / 100 : null,
    strikeRate: decided > 0 ? Math.round((counts.won / decided) * 10000) / 100 : null,
    byBookmaker: breakdown(settled, (b) => b.bookmaker),
    byMarket: breakdown(settled, (b) => b.market),
  };
}
