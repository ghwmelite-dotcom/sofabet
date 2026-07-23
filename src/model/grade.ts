/**
 * Grading of frozen pre-kickoff prediction snapshots against final scores
 * (pure functions). Predicted 1X2 side = argmax of the snapshot; O2.5/BTTS
 * predicted side = snapshot prob >= 0.5. logLoss/brier are computed on the
 * snapshot 1X2 vector only.
 */

export interface SnapshotLike {
  home_win: number;
  draw: number;
  away_win: number;
  over25: number;
  btts_yes: number;
  top_score: string;
}

export type PredictedSide = "home" | "draw" | "away";

export interface GradedPrediction {
  predicted: PredictedSide;
  outcomeHit: boolean;
  over25Hit: boolean;
  bttsHit: boolean;
  topScoreHit: boolean;
  logLoss: number;
  brier: number;
}

const SIDES: PredictedSide[] = ["home", "draw", "away"];

export function gradePrediction(snap: SnapshotLike, homeGoals: number, awayGoals: number): GradedPrediction {
  const probs = [snap.home_win, snap.draw, snap.away_win];
  let predIdx = 0;
  for (let i = 1; i < 3; i++) if (probs[i] > probs[predIdx]) predIdx = i;
  const outcomeIdx = homeGoals > awayGoals ? 0 : homeGoals === awayGoals ? 1 : 2;

  const over25Actual = homeGoals + awayGoals >= 3;
  const bttsActual = homeGoals >= 1 && awayGoals >= 1;

  let brier = 0;
  for (let k = 0; k < 3; k++) brier += (probs[k] - (k === outcomeIdx ? 1 : 0)) ** 2;

  return {
    predicted: SIDES[predIdx],
    outcomeHit: predIdx === outcomeIdx,
    over25Hit: (snap.over25 >= 0.5) === over25Actual,
    bttsHit: (snap.btts_yes >= 0.5) === bttsActual,
    topScoreHit: snap.top_score === `${homeGoals}-${awayGoals}`,
    logLoss: -Math.log(Math.max(probs[outcomeIdx], 1e-12)),
    brier,
  };
}

export interface GradeSummary {
  count: number;
  outcomeHitRate: number;
  over25HitRate: number;
  bttsHitRate: number;
  topScoreHitRate: number;
  meanLogLoss: number;
  meanBrier: number;
}

export function summarizeGrades(rows: GradedPrediction[]): GradeSummary | null {
  if (rows.length === 0) return null;
  const mean = (f: (g: GradedPrediction) => number) => rows.reduce((a, g) => a + f(g), 0) / rows.length;
  return {
    count: rows.length,
    outcomeHitRate: mean((g) => (g.outcomeHit ? 1 : 0)),
    over25HitRate: mean((g) => (g.over25Hit ? 1 : 0)),
    bttsHitRate: mean((g) => (g.bttsHit ? 1 : 0)),
    topScoreHitRate: mean((g) => (g.topScoreHit ? 1 : 0)),
    meanLogLoss: mean((g) => g.logLoss),
    meanBrier: mean((g) => g.brier),
  };
}
