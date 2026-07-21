import { describe, expect, it } from "vitest";
import { predictScoreGrid } from "../src/model/dixonColes";
import type { FittedParams } from "../src/model/dixonColes";
import { awayMargins, gridToMarkets, homeMargins } from "../src/model/markets";
import type { AsianHandicapLine } from "../src/model/markets";

// Asymmetric fixture: home favorite with a low-score rho tweak.
const params: FittedParams = {
  teamIds: [1, 2],
  attack: [0.45, -0.1],
  defence: [0.05, -0.2],
  homeAdv: 0.3,
  rho: -0.08,
};
const grid = predictScoreGrid(params, 1, 2);
const markets = gridToMarkets(grid);

function ahHome(line: number): AsianHandicapLine {
  const found = markets.asianHandicap.home.find((l) => l.line === line);
  if (!found) throw new Error(`no home AH line ${line}`);
  return found;
}
function ahAway(line: number): AsianHandicapLine {
  const found = markets.asianHandicap.away.find((l) => l.line === line);
  if (!found) throw new Error(`no away AH line ${line}`);
  return found;
}

describe("doubleChance", () => {
  it("is consistent with 1X2", () => {
    expect(markets.doubleChance.homeOrDraw).toBeCloseTo(markets.homeWin + markets.draw, 10);
    expect(markets.doubleChance.awayOrDraw).toBeCloseTo(markets.awayWin + markets.draw, 10);
    expect(markets.doubleChance.homeOrAway).toBeCloseTo(markets.homeWin + markets.awayWin, 10);
  });
});

describe("drawNoBet", () => {
  it("renormalizes to 1 and fairOdds = 1/p", () => {
    const { home, away, fairOddsHome, fairOddsAway } = markets.drawNoBet;
    expect(home + away).toBeCloseTo(1, 10);
    expect(home).toBeCloseTo(markets.homeWin / (markets.homeWin + markets.awayWin), 10);
    expect(fairOddsHome).toBeCloseTo(1 / home, 10);
    expect(fairOddsAway).toBeCloseTo(1 / away, 10);
  });
});

describe("asianHandicap", () => {
  it("covers -2.0..+2.0 step 0.25 (17 lines per side)", () => {
    expect(markets.asianHandicap.home.length).toBe(17);
    expect(markets.asianHandicap.away.length).toBe(17);
    expect(markets.asianHandicap.home[0].line).toBe(-2);
    expect(markets.asianHandicap.home[16].line).toBe(2);
  });

  it("every line: pWin + pPush + pLose = 1, all in [0,1]", () => {
    for (const side of [markets.asianHandicap.home, markets.asianHandicap.away]) {
      for (const l of side) {
        expect(l.pWin + l.pPush + l.pLose).toBeCloseTo(1, 9);
        for (const p of [l.pWin, l.pPush, l.pLose]) {
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("line 0 equals draw-no-bet", () => {
    const line0 = ahHome(0);
    expect(line0.pWin).toBeCloseTo(markets.homeWin, 10);
    expect(line0.pPush).toBeCloseTo(markets.draw, 10);
    expect(line0.pLose).toBeCloseTo(markets.awayWin, 10);
    // fairOdds = (1 - pPush) / pWin must equal 1 / dnbHome.
    expect(line0.fairOdds).toBeCloseTo(1 / markets.drawNoBet.home, 8);
    expect(line0.pWin / (1 - line0.pPush)).toBeCloseTo(markets.drawNoBet.home, 10);
  });

  it("half lines have no pushes; fairOdds = 1/pWin there", () => {
    const l = ahHome(-0.5);
    expect(l.pPush).toBe(0);
    expect(l.pWin).toBeCloseTo(markets.homeWin, 10); // -0.5 == straight home win
    expect(l.fairOdds).toBeCloseTo(1 / l.pWin, 10);
  });

  it("quarter lines are the half-stake average of adjacent lines", () => {
    for (const q of [-0.25, 0.75, -1.25, 1.75]) {
      const lo = ahHome(q - 0.25);
      const hi = ahHome(q + 0.25);
      const mid = ahHome(q);
      expect(mid.pWin).toBeCloseTo((lo.pWin + hi.pWin) / 2, 10);
      expect(mid.pPush).toBeCloseTo((lo.pPush + hi.pPush) / 2, 10);
      expect(mid.pLose).toBeCloseTo((lo.pLose + hi.pLose) / 2, 10);
    }
    // Quarter-line push is half of the whole-line push.
    expect(ahHome(-0.25).pPush).toBeCloseTo(ahHome(0).pPush / 2, 10);
  });

  it("away side is the negated home side with win/lose swapped", () => {
    for (const q of [-2, -0.75, 0, 0.25, 1.5, 2]) {
      const h = ahHome(-q);
      const a = ahAway(q);
      expect(a.pWin).toBeCloseTo(h.pLose, 10);
      expect(a.pPush).toBeCloseTo(h.pPush, 10);
      expect(a.pLose).toBeCloseTo(h.pWin, 10);
    }
    // away +0.5 == X2.
    expect(ahAway(0.5).pWin).toBeCloseTo(markets.doubleChance.awayOrDraw, 10);
  });
});

describe("europeanHandicap", () => {
  it("line 0 equals 1X2", () => {
    const line0 = markets.europeanHandicap.find((l) => l.line === 0);
    expect(line0).toBeDefined();
    expect(line0?.pHome).toBeCloseTo(markets.homeWin, 10);
    expect(line0?.pDraw).toBeCloseTo(markets.draw, 10);
    expect(line0?.pAway).toBeCloseTo(markets.awayWin, 10);
  });

  it("lines shift probability monotonically; rows sum to 1", () => {
    const rows = markets.europeanHandicap;
    expect(rows.map((r) => r.line)).toEqual([-2, -1, 0, 1, 2]);
    for (const r of rows) {
      expect(r.pHome + r.pDraw + r.pAway).toBeCloseTo(1, 9);
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].pHome).toBeGreaterThan(rows[i - 1].pHome);
    }
  });
});

describe("teamTotals", () => {
  it("lines 0.5..3.5 per side, over + under = 1, consistent with margins", () => {
    const home = homeMargins(grid);
    const away = awayMargins(grid);
    expect(markets.teamTotals.home.map((l) => l.line)).toEqual([0.5, 1.5, 2.5, 3.5]);
    for (const [lines, margins] of [
      [markets.teamTotals.home, home],
      [markets.teamTotals.away, away],
    ] as const) {
      for (const l of lines) {
        expect(l.over + l.under).toBeCloseTo(1, 10);
        const expected = margins.reduce((acc, p, k) => (k > l.line ? acc + p : acc), 0);
        expect(l.over).toBeCloseTo(expected, 10);
      }
    }
  });

  it("team totals are consistent with match totals and expected goals", () => {
    // Match over 0.5 == 1 - P(0-0).
    const over05 = markets.overUnder.find((l) => l.line === 0.5);
    expect(over05?.over).toBeCloseTo(1 - grid[0][0], 10);
    // Expected goals from margins match the market-level expectations.
    const xHome = homeMargins(grid).reduce((acc, p, k) => acc + k * p, 0);
    const xAway = awayMargins(grid).reduce((acc, p, k) => acc + k * p, 0);
    expect(xHome).toBeCloseTo(markets.expectedHomeGoals, 10);
    expect(xAway).toBeCloseTo(markets.expectedAwayGoals, 10);
  });
});
