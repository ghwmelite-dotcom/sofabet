/**
 * Derive outcome-market probabilities (1X2, BTTS, totals) from a score grid
 * (pure functions). Grid convention: grid[x][y] = P(home goals = x, away goals = y).
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
}

const OVER_UNDER_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const TOP_SCORES = 5;

export function gridToMarkets(grid: number[][]): Markets {
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let bttsYes = 0;
  let expectedHomeGoals = 0;
  let expectedAwayGoals = 0;
  // over[i] accumulates P(total > line_i) i.e. total >= floor(line)+1.
  const over = OVER_UNDER_LINES.map(() => 0);
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
      const total = x + y;
      for (let i = 0; i < OVER_UNDER_LINES.length; i++) {
        if (total > OVER_UNDER_LINES[i]) over[i] += p;
      }
      scores.push({ home: x, away: y, prob: p });
    }
  }

  scores.sort((a, b) => b.prob - a.prob);

  return {
    homeWin,
    draw,
    awayWin,
    bttsYes,
    bttsNo: 1 - bttsYes,
    overUnder: OVER_UNDER_LINES.map((line, i) => ({ line, over: over[i], under: 1 - over[i] })),
    topScores: scores.slice(0, TOP_SCORES),
    expectedHomeGoals,
    expectedAwayGoals,
  };
}
