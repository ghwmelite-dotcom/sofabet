/**
 * Yellow-cards model (pure functions). Same fitting shape as the goals model
 * but plain independent Poisson — no rho/tau low-score correction:
 *   lambda_home = exp(cardsAttack_home - cardsDefence_away + cardsHomeAdv)
 *   lambda_away = exp(cardsAttack_away - cardsDefence_home)
 * where cardsAttack is a team's tendency to COLLECT yellows and cardsDefence
 * its tendency to make OPPONENTS collect yellows. Reuses the shared
 * fitBivariatePoisson optimizer (same xi, L2, Adam, alpha re-centering) and
 * the score-grid machinery with rho = 0.
 *
 * Params are stored in the FittedParams shape (attack = cardsAttack,
 * defence = cardsDefence, homeAdv = cardsHomeAdv, rho = 0) so model_cache
 * serialization and prediction helpers are shared with the goals model.
 */

import { fitBivariatePoisson, predictScoreGrid } from "./dixonColes";
import type { FittedParams, FitOptions } from "./dixonColes";
import { awayMargins, homeMargins, matchTotalOverUnder, teamTotalsFromGrid } from "./markets";
import type { OverUnderLine } from "./markets";
import type { CardMatch } from "../types";

export type { CardMatch };

export type CardsParams = FittedParams;

export interface CardsMarkets {
  expectedHomeYellow: number;
  expectedAwayYellow: number;
  expectedTotalYellow: number;
  /** Combined-yellows lines 1.5..6.5. */
  totalOverUnder: OverUnderLine[];
  /** Per-team yellow lines 1.5 and 2.5. */
  homeOverUnder: OverUnderLine[];
  awayOverUnder: OverUnderLine[];
}

const TOTAL_LINES = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5];
const TEAM_LINES = [1.5, 2.5];
const MAX_CARDS = 12;

/** Fit the cards model on matches with booked-yellow counts. */
export function fitCards(matches: CardMatch[], opts: FitOptions = {}): CardsParams {
  const asGoals = matches.map((m) => ({
    homeTeamId: m.homeTeamId,
    awayTeamId: m.awayTeamId,
    homeGoals: m.homeYellow,
    awayGoals: m.awayYellow,
    utcDate: m.utcDate,
  }));
  return fitBivariatePoisson(asGoals, { ...opts, useTau: false });
}

/** P(home = x, away = y) yellow-card grid, 0..12 per side, sums to 1. */
export function predictCardsGrid(
  params: CardsParams,
  homeTeamId: number,
  awayTeamId: number,
  maxCards = MAX_CARDS,
): number[][] {
  // rho = 0 in cards params, so this is an independent-Poisson grid.
  return predictScoreGrid(params, homeTeamId, awayTeamId, maxCards);
}

export function cardsGridToMarkets(grid: number[][]): CardsMarkets {
  const home = homeMargins(grid);
  const away = awayMargins(grid);
  let expectedHomeYellow = 0;
  let expectedAwayYellow = 0;
  for (let k = 0; k < home.length; k++) expectedHomeYellow += k * home[k];
  for (let k = 0; k < away.length; k++) expectedAwayYellow += k * away[k];
  return {
    expectedHomeYellow,
    expectedAwayYellow,
    expectedTotalYellow: expectedHomeYellow + expectedAwayYellow,
    totalOverUnder: matchTotalOverUnder(grid, TOTAL_LINES),
    homeOverUnder: teamTotalsFromGrid(home, TEAM_LINES),
    awayOverUnder: teamTotalsFromGrid(away, TEAM_LINES),
  };
}
