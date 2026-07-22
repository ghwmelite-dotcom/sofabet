/**
 * Team-form computation (pure): last-N results, goals for/against, and
 * venue splits from finished-match rows. Used by GET /api/form.
 */

import type { FormMatchRow } from "../types";

export interface FormGame {
  utcDate: string;
  opponentName: string;
  homeAway: "home" | "away";
  goalsFor: number;
  goalsAgainst: number;
  result: "W" | "D" | "L";
}

export interface FormSplit {
  played: number;
  gf: number;
  ga: number;
}

export interface TeamForm {
  recent: FormGame[];
  overall: FormSplit;
  home: FormSplit;
  away: FormSplit;
}

function toGame(row: FormMatchRow, teamId: number): FormGame {
  const isHome = row.home_team_id === teamId;
  const goalsFor = isHome ? row.home_goals : row.away_goals;
  const goalsAgainst = isHome ? row.away_goals : row.home_goals;
  return {
    utcDate: row.utc_date,
    opponentName: isHome ? row.away_name : row.home_name,
    homeAway: isHome ? "home" : "away",
    goalsFor,
    goalsAgainst,
    result: goalsFor > goalsAgainst ? "W" : goalsFor === goalsAgainst ? "D" : "L",
  };
}

function split(games: FormGame[]): FormSplit {
  return {
    played: games.length,
    gf: games.reduce((a, g) => a + g.goalsFor, 0),
    ga: games.reduce((a, g) => a + g.goalsAgainst, 0),
  };
}

/**
 * Compute form for `teamId` from finished matches newest-first.
 * `recent`/`overall` use the first 5 rows of any venue; the home/away splits
 * use the first 5 home and first 5 away rows respectively.
 */
export function computeTeamForm(rows: FormMatchRow[], teamId: number, last = 5): TeamForm {
  const games = rows.map((r) => toGame(r, teamId));
  return {
    recent: games.slice(0, last),
    overall: split(games.slice(0, last)),
    home: split(games.filter((g) => g.homeAway === "home").slice(0, last)),
    away: split(games.filter((g) => g.homeAway === "away").slice(0, last)),
  };
}
