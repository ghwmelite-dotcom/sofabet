import { describe, expect, it } from "vitest";
import { evaluateBet, settleProfit, summarizeBets } from "../src/model/bets";
import type { BetRow } from "../src/types";

describe("evaluateBet", () => {
  it("1X2", () => {
    expect(evaluateBet("1X2", "home", null, 2, 1)).toBe("won");
    expect(evaluateBet("1X2", "home", null, 1, 1)).toBe("lost");
    expect(evaluateBet("1X2", "draw", null, 0, 0)).toBe("won");
    expect(evaluateBet("1X2", "draw", null, 3, 1)).toBe("lost");
    expect(evaluateBet("1X2", "away", null, 0, 2)).toBe("won");
    expect(evaluateBet("1X2", "away", null, 2, 0)).toBe("lost");
    expect(evaluateBet("1X2", "HOME", null, 2, 1)).toBe("won"); // case-insensitive
    expect(evaluateBet("1X2", "1", null, 2, 1)).toBeNull(); // unsupported selection
  });

  it("doubleChance", () => {
    expect(evaluateBet("doubleChance", "1X", null, 1, 1)).toBe("won");
    expect(evaluateBet("doubleChance", "1X", null, 0, 1)).toBe("lost");
    expect(evaluateBet("doubleChance", "X2", null, 1, 1)).toBe("won");
    expect(evaluateBet("doubleChance", "X2", null, 2, 1)).toBe("lost");
    expect(evaluateBet("doubleChance", "12", null, 2, 1)).toBe("won");
    expect(evaluateBet("doubleChance", "12", null, 2, 2)).toBe("lost");
    expect(evaluateBet("doubleChance", "1x2", null, 1, 1)).toBeNull();
  });

  it("overUnder incl. exact-line push (void)", () => {
    expect(evaluateBet("overUnder", "over", 2.5, 2, 1)).toBe("won");
    expect(evaluateBet("overUnder", "over", 2.5, 1, 1)).toBe("lost");
    expect(evaluateBet("over", "under", 2.5, 1, 0)).toBeNull(); // market name is overUnder
    expect(evaluateBet("overUnder", "under", 2.5, 1, 0)).toBe("won");
    expect(evaluateBet("overUnder", "under", 2.5, 2, 2)).toBe("lost");
    // Exact line landings push:
    expect(evaluateBet("overUnder", "over", 2, 1, 1)).toBe("void");
    expect(evaluateBet("overUnder", "under", 3, 2, 1)).toBe("void");
    expect(evaluateBet("overUnder", "over", 2, 2, 1)).toBe("won"); // 3 > 2
    // Missing line or selection -> unsupported
    expect(evaluateBet("overUnder", "over", null, 2, 1)).toBeNull();
    expect(evaluateBet("overUnder", "totals", 2.5, 2, 1)).toBeNull();
  });

  it("btts", () => {
    expect(evaluateBet("btts", "yes", null, 1, 1)).toBe("won");
    expect(evaluateBet("btts", "yes", null, 1, 0)).toBe("lost");
    expect(evaluateBet("btts", "no", null, 0, 2)).toBe("won");
    expect(evaluateBet("btts", "no", null, 2, 2)).toBe("lost");
    expect(evaluateBet("btts", "maybe", null, 1, 1)).toBeNull();
  });

  it("unsupported markets return null", () => {
    expect(evaluateBet("asianHandicap", "home", -0.5, 2, 1)).toBeNull();
    expect(evaluateBet("correctScore", "2-1", null, 2, 1)).toBeNull();
  });
});

describe("settleProfit", () => {
  it("won = stake*(odds-1), lost = -stake, void = 0, rounded to cents", () => {
    expect(settleProfit("won", 2.5, 10)).toBe(15);
    expect(settleProfit("lost", 2.5, 10)).toBe(-10);
    expect(settleProfit("void", 2.5, 10)).toBe(0);
    expect(settleProfit("won", 1.91, 7)).toBe(6.37); // 7*0.91 = 6.369999...
  });
});

function bet(partial: Partial<BetRow>): BetRow {
  return {
    id: 0,
    created_at: "2026-01-01T00:00:00Z",
    league: "TEST",
    match_id: null,
    match_label: "A vs B",
    bookmaker: "SportyBet",
    market: "1X2",
    selection: "home",
    line: null,
    odds: 2,
    stake: 10,
    status: "open",
    settled_at: null,
    profit: null,
    ...partial,
  };
}

describe("summarizeBets", () => {
  it("aggregates totals, counts, ROI, strike rate and breakdowns", () => {
    const rows = [
      bet({ id: 1, status: "won", stake: 10, odds: 2, profit: 10, bookmaker: "SportyBet", market: "1X2" }),
      bet({ id: 2, status: "lost", stake: 10, odds: 1.8, profit: -10, bookmaker: "1xBet", market: "btts" }),
      bet({ id: 3, status: "void", stake: 5, odds: 2, profit: 0, bookmaker: "1xBet", market: "overUnder" }),
      bet({ id: 4, status: "open", stake: 20, odds: 2 }),
    ];
    const s = summarizeBets(rows);
    expect(s.counts).toEqual({ open: 1, won: 1, lost: 1, void: 1 });
    expect(s.staked).toBe(25); // 10 + 10 + 5 (settled only)
    expect(s.openStaked).toBe(20);
    expect(s.profit).toBe(0); // 10 - 10 + 0
    expect(s.roiPct).toBe(0);
    expect(s.strikeRate).toBe(50); // 1 won / 2 decided
    expect(s.byBookmaker.length).toBe(2);
    const sporty = s.byBookmaker.find((b) => b.key === "SportyBet");
    expect(sporty).toMatchObject({ bets: 1, staked: 10, profit: 10, roiPct: 100 });
    // Breakdowns cover settled bets only.
    expect(s.byBookmaker.reduce((a, b) => a + b.bets, 0)).toBe(3);
    expect(s.byMarket.map((m) => m.key).sort()).toEqual(["1X2", "btts", "overUnder"]);
  });

  it("handles empty and all-open histories", () => {
    const empty = summarizeBets([]);
    expect(empty.roiPct).toBeNull();
    expect(empty.strikeRate).toBeNull();
    expect(empty.staked).toBe(0);
    const open = summarizeBets([bet({ id: 1, stake: 5 })]);
    expect(open.roiPct).toBeNull();
    expect(open.strikeRate).toBeNull();
    expect(open.openStaked).toBe(5);
    expect(open.byBookmaker).toEqual([]);
  });
});
