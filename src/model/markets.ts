/**
 * Derive outcome-market probabilities (1X2, BTTS, totals, handicaps) from a
 * score grid (pure functions). Grid convention: grid[x][y] = P(home = x, away = y).
 */

export interface OverUnderLine {
  line: number;
  over: number;
  under: number;
}

export interface CorrectScore {
  home: number;
  away: number;
  prob: number;
}

export interface DoubleChance {
  homeOrDraw: number; // 1X
  awayOrDraw: number; // X2
  homeOrAway: number; // 12
}

export interface DrawNoBet {
  home: number;
  away: number;
  /** 1 / p (null when p = 0). */
  fairOddsHome: number | null;
  fairOddsAway: number | null;
}

export interface TeamTotals {
  home: OverUnderLine[];
  away: OverUnderLine[];
}

export interface AsianHandicapLine {
  line: number;
  pWin: number;
  pPush: number;
  pLose: number;
  /** Effective decimal odds with pushes treated as void: (1 - pPush) / pWin. Null when pWin = 0. */
  fairOdds: number | null;
}

export interface AsianHandicap {
  home: AsianHandicapLine[];
  away: AsianHandicapLine[];
}

export interface EuropeanHandicapLine {
  line: number;
  pHome: number;
  pDraw: number;
  pAway: number;
}

export interface Markets {
  homeWin: number;
  draw: number;
  awayWin: number;
  bttsYes: number;
  bttsNo: number;
  overUnder: OverUnderLine[];
  topScores: CorrectScore[];
  expectedHomeGoals: number;
  expectedAwayGoals: number;
  doubleChance: DoubleChance;
  drawNoBet: DrawNoBet;
  teamTotals: TeamTotals;
  asianHandicap: AsianHandicap;
  europeanHandicap: EuropeanHandicapLine[];
}

const OVER_UNDER_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const TEAM_TOTAL_LINES = [0.5, 1.5, 2.5, 3.5];
const TOP_SCORES = 5;
// Asian handicap ladder in quarter-goal units: -2.0 .. +2.0 step 0.25.
const AH_QUARTER_MIN = -8;
const AH_QUARTER_MAX = 8;
const EH_LINES = [-2, -1, 0, 1, 2];

/** P(home goals = x) for each x (grid row sums). */
export function homeMargins(grid: number[][]): number[] {
  return grid.map((row) => row.reduce((a, b) => a + b, 0));
}

/** P(away goals = y) for each y (grid column sums). */
export function awayMargins(grid: number[][]): number[] {
  const out = new Array<number>(grid[0]?.length ?? 0).fill(0);
  for (const row of grid) {
    for (let y = 0; y < row.length; y++) out[y] += row[y];
  }
  return out;
}

/** Over/under for one team's goals from its marginal distribution. */
export function teamTotalsFromGrid(margins: number[], lines: number[]): OverUnderLine[] {
  return lines.map((line) => {
    let over = 0;
    for (let k = 0; k < margins.length; k++) {
      if (k > line) over += margins[k];
    }
    return { line, over, under: 1 - over };
  });
}

/** Over/under for the combined (home + away) total. */
export function matchTotalOverUnder(grid: number[][], lines: number[]): OverUnderLine[] {
  const over = lines.map(() => 0);
  for (let x = 0; x < grid.length; x++) {
    for (let y = 0; y < grid[x].length; y++) {
      const total = x + y;
      for (let i = 0; i < lines.length; i++) {
        if (total > lines[i]) over[i] += grid[x][y];
      }
    }
  }
  return lines.map((line, i) => ({ line, over: over[i], under: 1 - over[i] }));
}

/** Margin distribution: P(home - away = m) keyed by integer margin. */
function marginDistribution(grid: number[][]): Map<number, number> {
  const dist = new Map<number, number>();
  for (let x = 0; x < grid.length; x++) {
    for (let y = 0; y < grid[x].length; y++) {
      const m = x - y;
      dist.set(m, (dist.get(m) ?? 0) + grid[x][y]);
    }
  }
  return dist;
}

function ahFairOdds(pWin: number, pPush: number): number | null {
  if (pWin <= 0) return null;
  return (1 - pPush) / pWin;
}

/**
 * Asian handicap ladder for the home team, lines -2.0..+2.0 step 0.25.
 * Whole and half lines come straight from the margin distribution (win/push/
 * lose on margin + line); quarter lines are the half-stake average of the two
 * adjacent lines. Integer comparisons are done in quarter-goal units to avoid
 * float drift.
 */
function asianHandicapHome(grid: number[][]): AsianHandicapLine[] {
  const dist = marginDistribution(grid);
  const direct = new Map<number, AsianHandicapLine>(); // key: line * 4
  for (let q = AH_QUARTER_MIN; q <= AH_QUARTER_MAX; q += 2) {
    let pWin = 0;
    let pPush = 0;
    for (const [m, p] of dist) {
      const v = 4 * m + q; // sign of (margin + line), in exact quarter units
      if (v > 0) pWin += p;
      else if (v === 0) pPush += p;
    }
    const pLose = Math.max(0, 1 - pWin - pPush);
    direct.set(q, { line: q / 4, pWin, pPush, pLose, fairOdds: ahFairOdds(pWin, pPush) });
  }
  const ladder: AsianHandicapLine[] = [];
  for (let q = AH_QUARTER_MIN; q <= AH_QUARTER_MAX; q++) {
    if (q % 2 === 0) {
      ladder.push(direct.get(q) as AsianHandicapLine);
    } else {
      const lo = direct.get(q - 1) as AsianHandicapLine;
      const hi = direct.get(q + 1) as AsianHandicapLine;
      const pWin = (lo.pWin + hi.pWin) / 2;
      const pPush = (lo.pPush + hi.pPush) / 2;
      const pLose = (lo.pLose + hi.pLose) / 2;
      ladder.push({ line: q / 4, pWin, pPush, pLose, fairOdds: ahFairOdds(pWin, pPush) });
    }
  }
  return ladder;
}

/** Away side: away line L is the home line -L with win/lose swapped. */
function asianHandicapAway(homeLadder: AsianHandicapLine[]): AsianHandicapLine[] {
  const byLine = new Map(homeLadder.map((l) => [l.line, l]));
  const ladder: AsianHandicapLine[] = [];
  for (let q = AH_QUARTER_MIN; q <= AH_QUARTER_MAX; q++) {
    const line = q / 4;
    const h = byLine.get(-line) as AsianHandicapLine;
    const pWin = h.pLose;
    const pPush = h.pPush;
    const pLose = h.pWin;
    ladder.push({ line, pWin, pPush, pLose, fairOdds: ahFairOdds(pWin, pPush) });
  }
  return ladder;
}

export function gridToMarkets(grid: number[][]): Markets {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let bttsYes = 0;
  let expectedHomeGoals = 0;
  let expectedAwayGoals = 0;
  const scores: CorrectScore[] = [];

  for (let x = 0; x < grid.length; x++) {
    for (let y = 0; y < grid[x].length; y++) {
      const p = grid[x][y];
      if (x > y) homeWin += p;
      else if (x === y) draw += p;
      else awayWin += p;
      if (x >= 1 && y >= 1) bttsYes += p;
      expectedHomeGoals += x * p;
      expectedAwayGoals += y * p;
      scores.push({ home: x, away: y, prob: p });
    }
  }

  scores.sort((a, b) => b.prob - a.prob);

  const dnbDenom = homeWin + awayWin;
  const dnbHome = dnbDenom > 0 ? homeWin / dnbDenom : 0;
  const dnbAway = dnbDenom > 0 ? awayWin / dnbDenom : 0;

  const ahHome = asianHandicapHome(grid);
  const ahByLine = new Map(ahHome.map((l) => [l.line, l]));

  return {
    homeWin,
    draw,
    awayWin,
    bttsYes,
    bttsNo: 1 - bttsYes,
    overUnder: matchTotalOverUnder(grid, OVER_UNDER_LINES),
    topScores: scores.slice(0, TOP_SCORES),
    expectedHomeGoals,
    expectedAwayGoals,
    doubleChance: {
      homeOrDraw: homeWin + draw,
      awayOrDraw: awayWin + draw,
      homeOrAway: homeWin + awayWin,
    },
    drawNoBet: {
      home: dnbHome,
      away: dnbAway,
      fairOddsHome: dnbHome > 0 ? 1 / dnbHome : null,
      fairOddsAway: dnbAway > 0 ? 1 / dnbAway : null,
    },
    teamTotals: {
      home: teamTotalsFromGrid(homeMargins(grid), TEAM_TOTAL_LINES),
      away: teamTotalsFromGrid(awayMargins(grid), TEAM_TOTAL_LINES),
    },
    asianHandicap: { home: ahHome, away: asianHandicapAway(ahHome) },
    europeanHandicap: EH_LINES.map((line) => {
      const ah = ahByLine.get(line) as AsianHandicapLine;
      return { line, pHome: ah.pWin, pDraw: ah.pPush, pAway: ah.pLose };
    }),
  };
}
