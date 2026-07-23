import { describe, expect, it } from "vitest";
import { buildTodayAcca, buildWeeklyRollover, combineAcca } from "../src/model/acca";
import type { AccaCandidate } from "../src/model/acca";

const NOW = "2026-07-23T17:00:00Z";

function cand(partial: Partial<AccaCandidate>): AccaCandidate {
  return {
    match_id: 1,
    match_league: "PL",
    utc_date: "2026-07-24T15:00:00Z",
    home_name: "Home FC",
    away_name: "Away FC",
    market: "h2h",
    selection: "home",
    line: null,
    best_odds: 2,
    consensus_odds: 1.9,
    bookmakers: 5,
    model_prob: 0.5,
    ev_pct: 0.05,
    ...partial,
  };
}

describe("combineAcca", () => {
  it("multiplies odds and probs; ev = product - 1", () => {
    const c = combineAcca([
      { modelProb: 0.5, bestOdds: 2 },
      { modelProb: 0.4, bestOdds: 2.5 },
    ]);
    expect(c.combinedOdds).toBeCloseTo(5, 12);
    expect(c.combinedProb).toBeCloseTo(0.2, 12);
    expect(c.evPct).toBeCloseTo(0, 12);
  });

  it("empty legs -> 1x products, ev 0", () => {
    expect(combineAcca([])).toEqual({ combinedOdds: 1, combinedProb: 1, evPct: 0 });
  });
});

describe("buildTodayAcca", () => {
  it("takes top-4 by ev, max one leg per match, within 24h only", () => {
    const candidates = [
      cand({ match_id: 1, ev_pct: 0.1, utc_date: "2026-07-24T10:00:00Z" }),
      cand({ match_id: 1, selection: "away", ev_pct: 0.2, utc_date: "2026-07-24T10:00:00Z" }), // same match, higher ev
      cand({ match_id: 2, ev_pct: 0.08, utc_date: "2026-07-23T20:00:00Z" }),
      cand({ match_id: 3, ev_pct: 0.07, utc_date: "2026-07-24T16:00:00Z" }),
      cand({ match_id: 4, ev_pct: 0.06, utc_date: "2026-07-24T16:30:00Z" }),
      cand({ match_id: 5, ev_pct: 0.05, utc_date: "2026-07-24T17:00:00Z" }), // 24h boundary (<=)
      cand({ match_id: 6, ev_pct: 0.9, utc_date: "2026-07-25T12:00:00Z" }), // outside 24h despite huge ev
      cand({ match_id: 7, ev_pct: 0.04, utc_date: "2026-07-24T18:00:00Z" }), // outside 24h
    ];
    const acca = buildTodayAcca(candidates, NOW);
    expect(acca).not.toBeNull();
    expect(acca?.legs.map((l) => l.matchId)).toEqual([1, 2, 3, 4]); // match 1 once (the higher-ev selection), boundary match 5 out (top-4 cut)
    expect(acca?.legs[0].selection).toBe("away"); // higher-ev leg of match 1 wins
  });

  it("includes a match exactly at the 24h boundary", () => {
    const acca = buildTodayAcca(
      [
        cand({ match_id: 1, utc_date: "2026-07-24T17:00:00Z", ev_pct: 0.06 }),
        cand({ match_id: 2, utc_date: "2026-07-23T18:00:00Z", ev_pct: 0.05 }),
      ],
      NOW,
    );
    expect(acca?.legs.length).toBe(2);
  });

  it("excludes longshot legs below the 0.30 prob floor even at the highest EV", () => {
    const candidates = [
      cand({ match_id: 1, model_prob: 0.2, best_odds: 7.8, ev_pct: 0.56, utc_date: "2026-07-23T22:00:00Z" }), // the Remo case
      cand({ match_id: 2, model_prob: 0.65, best_odds: 1.82, ev_pct: 0.19, utc_date: "2026-07-23T22:00:00Z" }),
      cand({ match_id: 3, model_prob: 0.55, best_odds: 2.0, ev_pct: 0.1, utc_date: "2026-07-23T23:00:00Z" }),
    ];
    const acca = buildTodayAcca(candidates, NOW);
    expect(acca?.legs.map((l) => l.matchId)).toEqual([2, 3]);
  });

  it("returns null with fewer than 2 legs", () => {
    expect(buildTodayAcca([cand({ match_id: 1 })], NOW)).toBeNull();
    expect(buildTodayAcca([], NOW)).toBeNull();
    // two candidates but same match -> one leg only -> null
    expect(
      buildTodayAcca(
        [cand({ match_id: 1 }), cand({ match_id: 1, selection: "away", ev_pct: 0.2 })],
        NOW,
      ),
    ).toBeNull();
  });
});

describe("buildWeeklyRollover", () => {
  it("picks the highest model_prob per calendar day above the 0.45 floor", () => {
    const candidates = [
      cand({ match_id: 1, utc_date: "2026-07-23T20:00:00Z", model_prob: 0.5, best_odds: 2 }),
      cand({ match_id: 2, utc_date: "2026-07-23T21:00:00Z", model_prob: 0.55, best_odds: 1.9 }),
      cand({ match_id: 3, utc_date: "2026-07-24T15:00:00Z", model_prob: 0.44, best_odds: 3 }), // below floor -> day null
      cand({ match_id: 4, utc_date: "2026-07-25T15:00:00Z", model_prob: 0.48, best_odds: 2.2 }),
    ];
    const r = buildWeeklyRollover(candidates, NOW);
    expect(r.days.length).toBe(7);
    expect(r.days[0].date).toBe("2026-07-23");
    expect(r.days[0].leg?.matchId).toBe(2); // higher prob of the two day-0 candidates
    expect(r.days[1].leg).toBeNull(); // 0.44 below floor
    expect(r.days[2].leg?.matchId).toBe(4);
    expect(r.days[3].leg).toBeNull();
    // Cumulative path skips null days: day0 (1.9 x 0.55), then day2 (x2.2 x0.48).
    expect(r.path.length).toBe(2);
    expect(r.path[0]).toMatchObject({ date: "2026-07-23" });
    expect(r.path[0].cumulativeOdds).toBeCloseTo(1.9, 12);
    expect(r.path[0].cumulativeProb).toBeCloseTo(0.55, 12);
    expect(r.path[1].cumulativeOdds).toBeCloseTo(1.9 * 2.2, 12);
    expect(r.path[1].cumulativeProb).toBeCloseTo(0.55 * 0.48, 12);
  });

  it("excludes matches earlier than now on day 0 and anything past day 6", () => {
    const r = buildWeeklyRollover(
      [
        cand({ match_id: 1, utc_date: "2026-07-23T10:00:00Z", model_prob: 0.6 }), // before now
        cand({ match_id: 2, utc_date: "2026-07-30T10:00:00Z", model_prob: 0.6 }), // day 7 (out of 0..6)
        cand({ match_id: 3, utc_date: "2026-07-29T10:00:00Z", model_prob: 0.6 }), // day 6, in
      ],
      NOW,
    );
    expect(r.days[0].leg).toBeNull();
    expect(r.days[6].leg?.matchId).toBe(3);
    expect(r.path.length).toBe(1);
  });

  it("respects the 0.45 boundary exactly", () => {
    const r = buildWeeklyRollover([cand({ match_id: 1, utc_date: "2026-07-23T20:00:00Z", model_prob: 0.45 })], NOW);
    expect(r.days[0].leg).not.toBeNull();
  });
});
