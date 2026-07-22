import { describe, expect, it } from "vitest";
import {
  aggregatePrices,
  dedupeEvents,
  evPct,
  fairImplied,
  gridProbTotalOver,
  isValueRow,
  latestPerCombo,
  matchEventToFixture,
  normalizeTeamName,
  resolveSportByTitle,
  teamNamesAlign,
} from "../src/model/odds";
import type { FixtureLike } from "../src/model/odds";
import { predictScoreGrid } from "../src/model/dixonColes";

describe("normalizeTeamName", () => {
  it("lowercases, strips punctuation and club-designator tokens, collapses whitespace", () => {
    expect(normalizeTeamName("Manchester United")).toBe("manchester united");
    expect(normalizeTeamName("Manchester United FC")).toBe("manchester united");
    expect(normalizeTeamName("Wolverhampton Wanderers")).toBe("wolverhampton wanderers");
    expect(normalizeTeamName("AFC Bournemouth")).toBe("bournemouth"); // designator tokens go anywhere
    expect(normalizeTeamName("Brighton & Hove Albion")).toBe("brighton hove albion");
    expect(normalizeTeamName("1. FC Köln")).toBe("1 koln");
    expect(normalizeTeamName("São Paulo FC")).toBe("sao paulo");
    expect(normalizeTeamName("Paris  Saint-Germain")).toBe("paris saint germain");
    expect(normalizeTeamName("Sheffield United AFC")).toBe("sheffield united");
    expect(normalizeTeamName("Club Atlético de Madrid")).toBe("atletico madrid");
    expect(normalizeTeamName("Olympique de Marseille")).toBe("marseille");
    expect(normalizeTeamName("Rennes")).toBe("rennais"); // token alias
    expect(normalizeTeamName("Stade Rennais FC")).toBe("rennais");
  });
});

describe("teamNamesAlign (real cross-source pairs seen in production)", () => {
  const aligned: [string, string][] = [
    ["Bayern Munich", "FC Bayern München"],
    ["Augsburg", "FC Augsburg"],
    ["Marseille", "Olympique de Marseille"],
    ["Lyon", "Olympique Lyonnais"],
    ["Rennes", "Stade Rennais FC"],
    ["Athletic Bilbao", "Athletic Club"],
    ["Atlético Madrid", "Club Atlético de Madrid"],
    ["Inter Milan", "FC Internazionale Milano"],
    ["Brest", "Stade Brestois 29"],
    ["Zwolle", "PEC Zwolle"],
    ["Alavés", "Deportivo Alavés"],
    ["Rayo Vallecano", "Rayo Vallecano de Madrid"],
    ["Fiorentina", "ACF Fiorentina"],
    ["Ajax", "AFC Ajax"],
    ["Elversberg", "SV Elversberg"],
    ["Sport-Club Freiburg", "SC Freiburg"],
    ["Wolfsburg", "VfL Wolfsburg"],
    ["Lecce", "US Lecce"],
  ];
  for (const [a, b] of aligned) {
    it(`aligns "${a}" == "${b}"`, () => {
      expect(teamNamesAlign(a, b)).toBe(true);
      expect(teamNamesAlign(b, a)).toBe(true);
    });
  }

  it("does not align different clubs", () => {
    expect(teamNamesAlign("Real Madrid", "Real Sociedad")).toBe(false);
    expect(teamNamesAlign("Manchester United", "Manchester City")).toBe(false);
    expect(teamNamesAlign("Arsenal", "Aston Villa")).toBe(false);
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

  it("matches via token alignment (leading designators, missing tokens)", () => {
    const hit = matchEventToFixture(
      { id: "e2", home_team: "FC Köln", away_team: "Wolfsburg", commence_time: "2026-08-15T17:30:00Z" },
      fixtures,
    );
    expect(hit?.id).toBe(2);
  });

  it("accepts a unique league pairing despite multi-day date drift", () => {
    const hit = matchEventToFixture(
      { id: "e3", home_team: "Manchester United", away_team: "Fulham", commence_time: "2026-08-19T22:00:00Z" },
      fixtures,
    );
    expect(hit?.id).toBe(1); // pair occurs once per season — drift means one source has a stale date
  });

  it("rejects ambiguous duplicates when none are within 72h", () => {
    const fs: FixtureLike[] = [
      { id: 30, utcDate: "2026-08-20T15:00:00Z", homeTeamName: "Olympique Lyonnais", awayTeamName: "OGC Nice" },
      { id: 31, utcDate: "2026-08-25T15:00:00Z", homeTeamName: "Olympique Lyonnais", awayTeamName: "OGC Nice" },
    ];
    const hit = matchEventToFixture(
      { id: "e3c", home_team: "Lyon", away_team: "Nice", commence_time: "2026-08-15T15:00:00Z" },
      fs,
    );
    expect(hit).toBeNull();
  });

  it("tolerates placeholder-vs-real kickoff drift inside 72h", () => {
    const hit = matchEventToFixture(
      { id: "e3b", home_team: "Manchester United", away_team: "Fulham", commence_time: "2026-08-16T20:00:00Z" },
      fixtures,
    );
    expect(hit?.id).toBe(1);
  });

  it("rejects swapped home/away", () => {
    const hit = matchEventToFixture(
      { id: "e4", home_team: "Fulham", away_team: "Manchester United", commence_time: "2026-08-15T15:00:00Z" },
      fixtures,
    );
    expect(hit).toBeNull();
  });

  it("prefers the exact fixture over a token-aligned lookalike (Paris FC vs PSG)", () => {
    const fs: FixtureLike[] = [
      { id: 10, utcDate: "2026-08-15T15:00:00Z", homeTeamName: "Paris FC", awayTeamName: "Le Mans FC" },
      { id: 11, utcDate: "2026-08-15T15:00:00Z", homeTeamName: "Paris Saint-Germain FC", awayTeamName: "FC Metz" },
    ];
    const hit = matchEventToFixture(
      { id: "e5", home_team: "Paris FC", away_team: "Le Mans", commence_time: "2026-08-15T15:00:00Z" },
      fs,
    );
    expect(hit?.id).toBe(10);
  });

  it("returns null when only a different same-city club is in the fixture list", () => {
    const fs: FixtureLike[] = [
      { id: 20, utcDate: "2026-08-15T15:00:00Z", homeTeamName: "Real Sociedad", awayTeamName: "Getafe CF" },
    ];
    const hit = matchEventToFixture(
      { id: "e6", home_team: "Real Madrid", away_team: "Getafe", commence_time: "2026-08-15T15:00:00Z" },
      fs,
    );
    expect(hit).toBeNull();
  });
});

describe("dedupeEvents", () => {
  it("collapses duplicate matches keeping the one with the most bookmakers", () => {
    const events = [
      { id: "a", home_team: "Alavés", away_team: "Getafe", commence_time: "t", bookmakers: [1, 2] },
      { id: "b", home_team: "Deportivo Alavés", away_team: "Getafe CF", commence_time: "t", bookmakers: [1, 2, 3] },
      { id: "c", home_team: "Sevilla", away_team: "Rayo Vallecano", commence_time: "t", bookmakers: [1] },
    ];
    const out = dedupeEvents(events);
    expect(out.length).toBe(2);
    expect(out.some((e) => e.id === "b")).toBe(true);
    expect(out.some((e) => e.id === "a")).toBe(false);
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
