import { describe, expect, it } from "vitest";
import {
  buildTodayAccaV2,
  buildWeeklyRollover,
  dcPricesFromH2h,
  legMenu,
  pickBestLeg,
} from "../src/model/acca";
import type { AccaCandidate, MatchSnapshot, MenuLeg } from "../src/model/acca";
import { gridToMarkets } from "../src/model/markets";
import { predictScoreGrid } from "../src/model/dixonColes";

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

describe("buildWeeklyRollover (unchanged)", () => {
  it("picks the highest model_prob per calendar day above the 0.45 floor, skipping null days", () => {
    const candidates = [
      cand({ match_id: 1, utc_date: "2026-07-23T20:00:00Z", model_prob: 0.5, best_odds: 2 }),
      cand({ match_id: 2, utc_date: "2026-07-23T21:00:00Z", model_prob: 0.55, best_odds: 1.9 }),
      cand({ match_id: 3, utc_date: "2026-07-24T15:00:00Z", model_prob: 0.44, best_odds: 3 }),
      cand({ match_id: 4, utc_date: "2026-07-25T15:00:00Z", model_prob: 0.48, best_odds: 2.2 }),
    ];
    const r = buildWeeklyRollover(candidates, NOW);
    expect(r.days[0].leg?.matchId).toBe(2);
    expect(r.days[1].leg).toBeNull();
    expect(r.days[2].leg?.matchId).toBe(4);
    expect(r.path.length).toBe(2);
    expect(r.path[1].cumulativeOdds).toBeCloseTo(1.9 * 2.2, 12);
    expect(r.path[1].cumulativeProb).toBeCloseTo(0.55 * 0.48, 12);
  });
});

/* ---------- ACCA v2 ---------- */

describe("dcPricesFromH2h", () => {
  it("margin-normalizes a synthetic 1X2 book and derives DC odds", () => {
    // Book: 2.00 / 3.50 / 3.80 -> implied 0.5 / 0.2857 / 0.2632, sum 1.0489 (overround ~4.9%).
    const { o1X, oX2, o12 } = dcPricesFromH2h(2.0, 3.5, 3.8);
    const sum = 1 / 2.0 + 1 / 3.5 + 1 / 3.8;
    const pH = 0.5 / sum;
    const pD = 1 / 3.5 / sum;
    const pA = 1 / 3.8 / sum;
    expect(o1X).toBeCloseTo(1 / (pH + pD), 10);
    expect(oX2).toBeCloseTo(1 / (pA + pD), 10);
    expect(o12).toBeCloseTo(1 / (pH + pA), 10);
    // Sanity: derived DC prices are shorter than any component price.
    expect(o1X).toBeLessThan(2.0);
    expect(o12).toBeLessThan(2.0);
  });
});

const gridMarkets = gridToMarkets(
  predictScoreGrid({ teamIds: [1, 2], attack: [0.5, -0.3], defence: [0.1, -0.2], homeAdv: 0.25, rho: 0 }, 1, 2),
);

const SNAP: MatchSnapshot = {
  h2h: {
    home: { best: 1.85, consensus: 1.75, bookmakers: 6 },
    draw: { best: 3.8, consensus: 3.6, bookmakers: 6 },
    away: { best: 4.6, consensus: 4.4, bookmakers: 5 },
  },
  totals: new Map([["over|2.5", { best: 2.1, consensus: 2.0, bookmakers: 4 }]]),
};

describe("legMenu", () => {
  it("produces market, derived and model tiers with correct prices", () => {
    const menu = legMenu(gridMarkets, SNAP);
    const h2h = menu.find((l) => l.market === "h2h" && l.selection === "home");
    expect(h2h?.priceKind).toBe("market");
    expect(h2h?.price).toBe(1.85);
    expect(h2h?.evPct).toBeCloseTo(h2h!.modelProb * 1.85 - 1, 12);

    const dc = menu.filter((l) => l.market === "doubleChance");
    expect(dc.length).toBe(3);
    expect(dc[0].priceKind).toBe("derived");
    const expDc = dcPricesFromH2h(1.75, 3.6, 4.4);
    expect(dc.find((l) => l.selection === "1X")?.price).toBeCloseTo(expDc.o1X, 12);

    const totalsMarket = menu.find((l) => l.market === "totals" && l.priceKind === "market");
    expect(totalsMarket?.selection).toBe("over");
    expect(totalsMarket?.line).toBe(2.5);
    expect(totalsMarket?.price).toBe(2.1);

    const modelLegs = menu.filter((l) => l.priceKind === "model");
    // BTTS yes/no + 5 lines x 2 sides = 12 model legs.
    expect(modelLegs.length).toBe(12);
    expect(modelLegs.every((l) => l.evPct === null)).toBe(true);
    const btts = menu.find((l) => l.market === "btts" && l.selection === "yes");
    expect(btts?.price).toBeCloseTo(1 / btts!.modelProb, 12);
  });

  it("works snapshot-less: only model legs", () => {
    const menu = legMenu(gridMarkets, null);
    expect(menu.length).toBe(12);
    expect(menu.every((l) => l.priceKind === "model")).toBe(true);
  });
});

describe("pickBestLeg", () => {
  const leg = (partial: Partial<MenuLeg>): MenuLeg => ({
    market: "h2h",
    selection: "home",
    line: null,
    modelProb: 0.6,
    price: 2,
    priceKind: "market",
    evPct: 0.2,
    ...partial,
  });

  it("picks the highest modelProb above the 0.55 floor with the ev guard", () => {
    const pick = pickBestLeg([
      leg({ modelProb: 0.549, evPct: 5 }), // below prob floor
      leg({ modelProb: 0.6, evPct: -0.05 }), // fails ev guard (< -0.03)
      leg({ modelProb: 0.62, evPct: -0.02 }),
      leg({ modelProb: 0.58, evPct: 0.5 }),
    ]);
    expect(pick?.modelProb).toBe(0.62);
  });

  it("unpriced (model) legs are eligible regardless of ev", () => {
    const pick = pickBestLeg([leg({ modelProb: 0.9, priceKind: "model", evPct: null })]);
    expect(pick?.priceKind).toBe("model");
  });

  it("tie-breaks by evPct, then market > derived > model", () => {
    const pick = pickBestLeg([
      leg({ modelProb: 0.6, evPct: 0.1, priceKind: "model" }),
      leg({ modelProb: 0.6, evPct: 0.1, priceKind: "derived" }),
      leg({ modelProb: 0.6, evPct: 0.1, priceKind: "market" }),
    ]);
    expect(pick?.priceKind).toBe("market");
    const evTie = pickBestLeg([
      leg({ modelProb: 0.6, evPct: 0.1, priceKind: "market" }),
      leg({ modelProb: 0.6, evPct: 0.2, priceKind: "market", selection: "away" }),
    ]);
    expect(evTie?.selection).toBe("away");
  });

  it("returns null when nothing qualifies", () => {
    expect(pickBestLeg([leg({ modelProb: 0.4 })])).toBeNull();
    expect(pickBestLeg([])).toBeNull();
  });
});

describe("buildTodayAccaV2", () => {
  const meta = (id: number) => ({ matchId: id, league: "PL", utcDate: NOW, homeTeam: `H${id}`, awayTeam: `A${id}` });
  const leg = (partial: Partial<MenuLeg>): MenuLeg => ({
    market: "h2h",
    selection: "home",
    line: null,
    modelProb: 0.6,
    price: 2,
    priceKind: "market",
    evPct: 0.2,
    ...partial,
  });

  it("combines mixed priceKinds: products over all, EV over priced legs only", () => {
    const acca = buildTodayAccaV2([
      { match: meta(1), leg: leg({ modelProb: 0.6, price: 2, priceKind: "market" }) },
      { match: meta(2), leg: leg({ modelProb: 0.5, price: 1.5, priceKind: "derived" }) },
      { match: meta(3), leg: leg({ modelProb: 0.8, price: 1.25, priceKind: "model", evPct: null }) },
    ]);
    expect(acca).not.toBeNull();
    expect(acca?.legs.length).toBe(3);
    expect(acca?.combinedOdds).toBeCloseTo(2 * 1.5 * 1.25, 12);
    expect(acca?.combinedProb).toBeCloseTo(0.6 * 0.5 * 0.8, 12);
    // Priced EV: (0.6*2) * (0.5*1.5) - 1 = 1.2 * 0.75 - 1 = -0.1
    expect(acca?.evPct).toBeCloseTo(-0.1, 12);
    expect(acca?.modelLegs).toBe(1);
  });

  it("takes top-4 by modelProb and nulls below 2", () => {
    const five = [1, 2, 3, 4, 5].map((id) => ({ match: meta(id), leg: leg({ modelProb: 0.5 + id * 0.01 }) }));
    const acca = buildTodayAccaV2(five);
    expect(acca?.legs.map((l) => l.matchId)).toEqual([5, 4, 3, 2]);
    expect(buildTodayAccaV2([{ match: meta(1), leg: leg({}) }])).toBeNull();
    expect(buildTodayAccaV2([])).toBeNull();
  });

  it("evPct is null when every leg is model-priced", () => {
    const acca = buildTodayAccaV2([
      { match: meta(1), leg: leg({ modelProb: 0.8, price: 1.25, priceKind: "model", evPct: null }) },
      { match: meta(2), leg: leg({ modelProb: 0.7, price: 1.4, priceKind: "model", evPct: null }) },
    ]);
    expect(acca?.evPct).toBeNull();
    expect(acca?.modelLegs).toBe(2);
  });
});
