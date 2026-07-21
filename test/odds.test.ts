import { describe, expect, it } from "vitest";
import {
  aggregatePrices,
  evPct,
  fairImplied,
  gridProbTotalOver,
  isValueRow,
  latestPerCombo,
  matchEventToFixture,
  normalizeTeamName,
  resolveSportByTitle,
} from "../src/model/odds";
import type { FixtureLike } from "../src/model/odds";
import { predictScoreGrid } from "../src/model/dixonColes";

describe("normalizeTeamName", () => {
  it("lowercases, strips punctuation, drops trailing fc/afc/cf, collapses whitespace", () => {
    expect(normalizeTeamName("Manchester United")).toBe("manchester united");
    expect(normalizeTeamName("Manchester United FC")).toBe("manchester united");
    expect(normalizeTeamName("Wolverhampton Wanderers")).toBe("wolverhampton wanderers");
    expect(normalizeTeamName("AFC Bournemouth")).toBe("afc bournemouth"); // leading AFC is part of the name
    expect(normalizeTeamName("Brighton & Hove Albion")).toBe("brighton hove albion");
    expect(normalizeTeamName("1. FC Köln")).toBe("1 fc koln");
    expect(normalizeTeamName("São Paulo FC")).toBe("sao paulo");
    expect(normalizeTeamName("Paris  Saint-Germain")).toBe("paris saint germain");
    expect(normalizeTeamName("Sheffield United AFC")).toBe("sheffield united");
  });
});

const fixtures: FixtureLike[] = [
  { id: 1, utcDate: "2026-08-15T15:00:00Z", homeTeamName: "Manchester United", awayTeamName: "Fulham" },
  { id: 2, utcDate: "2026-08-15T17:30:00Z", homeTeamName: "1. FC Köln", awayTeamName: "VfL Wolfsburg" },
];

describe("matchEventToFixture", () => {
  it("matches exact pairs despite FC suffix differences", () => {
    const hit = matchEventToFixture(
      { id: "e1", home_team: "Manchester United FC", away_team: "Fulham FC", commence_time: "2026-08-15T16:00:00Z" },
      fixtures,
    );
    expect(hit?.id).toBe(1);
  });

  it("matches via the contains fallback", () => {
    const hit = matchEventToFixture(
      { id: "e2", home_team: "FC Köln", away_team: "Wolfsburg", commence_time: "2026-08-15T17:30:00Z" },
      fixtures,
    );
    expect(hit?.id).toBe(2);
  });

  it("rejects matches outside the 3h window", () => {
    const hit = matchEventToFixture(
      { id: "e3", home_team: "Manchester United", away_team: "Fulham", commence_time: "2026-08-15T22:00:00Z" },
      fixtures,
    );
    expect(hit).toBeNull();
  });

  it("rejects swapped home/away", () => {
    const hit = matchEventToFixture(
      { id: "e4", home_team: "Fulham", away_team: "Manchester United", commence_time: "2026-08-15T15:00:00Z" },
      fixtures,
    );
    expect(hit).toBeNull();
  });
});

describe("fairImplied (margin normalization)", () => {
  it("removes overround from a synthetic 3-way book", () => {
    const prices = [2.0, 3.5, 3.8];
    const raw = prices.map((p) => 1 / p);
    expect(raw.reduce((a, b) => a + b, 0)).toBeGreaterThan(1); // overround exists
    const fair = fairImplied(prices);
    expect(fair.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(fair[0]).toBeCloseTo(0.5 / raw.reduce((a, b) => a + b, 0), 12);
  });
});

describe("aggregatePrices + evPct", () => {
  it("consensus = mean, best = max, count = books (skipping junk)", () => {
    const agg = aggregatePrices([1.9, 2.0, 2.1, 1.0, Number.NaN]);
    expect(agg.consensus).toBeCloseTo(2.0, 12);
    expect(agg.best).toBe(2.1);
    expect(agg.bookmakers).toBe(3);
    expect(aggregatePrices([])).toEqual({ best: 0, consensus: 0, bookmakers: 0 });
  });

  it("evPct = modelProb * bestOdds - 1", () => {
    expect(evPct(0.5, 2.2)).toBeCloseTo(0.1, 12);
    expect(evPct(0.4, 2.0)).toBeCloseTo(-0.2, 12);
  });
});

describe("isValueRow filters", () => {
  const row = { model_prob: 0.5, ev_pct: 0.05, bookmakers: 3 };
  it("applies minEv, prob floor and book count", () => {
    expect(isValueRow(row)).toBe(true);
    expect(isValueRow(row, { minEv: 0.06 })).toBe(false);
    expect(isValueRow({ ...row, model_prob: 0.1 })).toBe(false);
    expect(isValueRow({ ...row, bookmakers: 2 })).toBe(false);
    expect(isValueRow({ ...row, ev_pct: 0.0399 })).toBe(false);
  });
});

describe("gridProbTotalOver", () => {
  it("matches the markets O/U lines and handles arbitrary lines", () => {
    const grid = predictScoreGrid({ teamIds: [1, 2], attack: [0, 0], defence: [0, 0], homeAdv: 0, rho: 0 }, 1, 2);
    // lambda = mu = 1: total ~ Poisson(2): P(>2.5) = 1 - e^-2 * (1 + 2 + 2) = 0.32332...
    expect(gridProbTotalOver(grid, 2.5)).toBeCloseTo(0.32332, 4);
    expect(gridProbTotalOver(grid, 0.5)).toBeCloseTo(1 - Math.exp(-2), 8);
    // Integer totals: total > 2 and total > 2.5 are the same event (>= 3).
    expect(gridProbTotalOver(grid, 2)).toBeCloseTo(0.32332, 4);
  });
});

describe("latestPerCombo (snapshot replace semantics)", () => {
  it("keeps only the newest row per match+market+selection(+line)", () => {
    const rows = [
      { match_id: 1, market: "h2h", selection: "home", line: null, fetched_at: "2026-08-01T04:00:00Z", ev_pct: 0.03 },
      { match_id: 1, market: "h2h", selection: "home", line: null, fetched_at: "2026-08-02T04:00:00Z", ev_pct: 0.06 },
      { match_id: 1, market: "totals", selection: "over", line: 2.5, fetched_at: "2026-08-01T04:00:00Z", ev_pct: 0.02 },
      { match_id: 1, market: "totals", selection: "over", line: 3.5, fetched_at: "2026-08-01T04:00:00Z", ev_pct: 0.05 },
    ];
    const latest = latestPerCombo(rows);
    expect(latest.length).toBe(3); // lines are distinct combos
    expect(latest.find((r) => r.market === "h2h")?.ev_pct).toBe(0.06);
  });
});

describe("resolveSportByTitle", () => {
  const sports = [
    { key: "soccer_epl", title: "Premier League" },
    { key: "soccer_efl_champ", title: "EFL Championship" },
    { key: "soccer_germany_bundesliga", title: "Bundesliga" },
    { key: "soccer_germany_bundesliga2", title: "Bundesliga 2" },
    { key: "soccer_spain_la_liga", title: "La Liga" },
    { key: "soccer_netherlands_eredivisie", title: "Eredivisie" },
  ];
  it("resolves by exact title and by contains without guessing", () => {
    expect(resolveSportByTitle("Premier League", sports)?.key).toBe("soccer_epl");
    expect(resolveSportByTitle("Championship", sports)?.key).toBe("soccer_efl_champ");
    expect(resolveSportByTitle("Bundesliga", sports)?.key).toBe("soccer_germany_bundesliga"); // exact beats contains
    expect(resolveSportByTitle("La Liga", sports)?.key).toBe("soccer_spain_la_liga");
    expect(resolveSportByTitle("Eredivisie", sports)?.key).toBe("soccer_netherlands_eredivisie");
    expect(resolveSportByTitle("Segunda Division", sports)).toBeNull();
  });
});
