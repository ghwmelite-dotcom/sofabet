import { describe, expect, it } from "vitest";
import { gradePrediction, summarizeGrades } from "../src/model/grade";

const snap = (over: Partial<Parameters<typeof gradePrediction>[0]>) => ({
  home_win: 0.5,
  draw: 0.3,
  away_win: 0.2,
  over25: 0.6,
  btts_yes: 0.55,
  top_score: "2-1",
  ...over,
});

describe("gradePrediction", () => {
  it("predicted side = argmax of the snapshot", () => {
    expect(gradePrediction(snap({}), 2, 1).predicted).toBe("home");
    expect(gradePrediction(snap({ home_win: 0.2, draw: 0.5, away_win: 0.3 }), 0, 0).predicted).toBe("draw");
    expect(gradePrediction(snap({ home_win: 0.1, draw: 0.2, away_win: 0.7 }), 0, 2).predicted).toBe("away");
  });

  it("computes all four hit types", () => {
    const g = gradePrediction(snap({}), 2, 1); // predicted home, O2.5 yes (0.6), BTTS yes (0.55), score 2-1
    expect(g.outcomeHit).toBe(true);
    expect(g.over25Hit).toBe(true);
    expect(g.bttsHit).toBe(true);
    expect(g.topScoreHit).toBe(true);

    const miss = gradePrediction(snap({}), 1, 0); // home win, 1 goal total, only home scored
    expect(miss.outcomeHit).toBe(true);
    expect(miss.over25Hit).toBe(false); // predicted over, actual under
    expect(miss.bttsHit).toBe(false); // predicted yes, actual no
    expect(miss.topScoreHit).toBe(false);

    const drawHit = gradePrediction(snap({ home_win: 0.2, draw: 0.45, away_win: 0.35 }), 1, 1);
    expect(drawHit.outcomeHit).toBe(true);
    expect(drawHit.predicted).toBe("draw");

    // Boundary: prob exactly 0.5 counts as predicting the "yes" side.
    const edge = gradePrediction(snap({ over25: 0.5, btts_yes: 0.5 }), 2, 1);
    expect(edge.over25Hit).toBe(true);
    expect(edge.bttsHit).toBe(true);
    const edge2 = gradePrediction(snap({ over25: 0.5 }), 1, 1);
    expect(edge2.over25Hit).toBe(false);
  });

  it("logLoss and brier match hand computation", () => {
    // probs [0.5, 0.3, 0.2], outcome = draw (index 1).
    const g = gradePrediction(snap({}), 0, 0);
    expect(g.logLoss).toBeCloseTo(-Math.log(0.3), 12);
    expect(g.brier).toBeCloseTo(0.5 ** 2 + (0.3 - 1) ** 2 + 0.2 ** 2, 12);
    // outcome = away (index 2).
    const a = gradePrediction(snap({}), 1, 2);
    expect(a.logLoss).toBeCloseTo(-Math.log(0.2), 12);
  });
});

describe("summarizeGrades", () => {
  it("aggregates counts, hit rates and means", () => {
    const rows = [
      gradePrediction(snap({}), 2, 1), // all hits
      gradePrediction(snap({}), 0, 0), // outcome miss (predicted home), over25 hit, btts miss, score miss
      gradePrediction(snap({}), 1, 3), // outcome miss, over25 hit, btts hit, score miss
    ];
    const s = summarizeGrades(rows);
    expect(s).not.toBeNull();
    expect(s?.count).toBe(3);
    expect(s?.outcomeHitRate).toBeCloseTo(1 / 3, 12);
    // over25: hit (2-1), miss (0-0), hit (1-3) -> 2/3.
    expect(s?.over25HitRate).toBeCloseTo(2 / 3, 12);
    // btts: hit, miss (0-0), hit -> 2/3.
    expect(s?.bttsHitRate).toBeCloseTo(2 / 3, 12);
    expect(s?.meanLogLoss).toBeGreaterThan(0);
    expect(s?.topScoreHitRate).toBeCloseTo(1 / 3, 12);
  });

  it("returns null for no rows", () => {
    expect(summarizeGrades([])).toBeNull();
  });
});
