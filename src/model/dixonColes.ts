/**
 * Dixon–Coles bivariate-Poisson model (pure functions, no bindings).
 *
 * Per league: attack alpha_i and defence beta_i per team, home advantage
 * gamma, low-score correlation rho.
 *   lambda = exp(alpha_home - beta_away + gamma)   (expected home goals)
 *   mu     = exp(alpha_away - beta_home)           (expected away goals)
 *
 * Weighted log-likelihood per match:
 *   w(t) * log[ Pois(x;lambda) * Pois(y;mu) * tau(x,y) ]
 * with the Dixon–Coles low-score correction
 *   tau(0,0) = 1 - lambda*mu*rho   tau(1,0) = 1 + mu*rho
 *   tau(0,1) = 1 + lambda*rho      tau(1,1) = 1 - rho      else 1
 * and exponential time decay w(t) = exp(-xi * days_ago), xi = 0.0018,
 * measured from the most recent match in the training set.
 *
 * Fit by full-batch gradient ascent (Adam) on the weighted log-likelihood
 * minus an L2 penalty 1e-4 * sum(alpha^2 + beta^2). Alpha is re-centered to
 * sum 0 after every iteration for identifiability; rho is clamped to
 * [-0.2, 0.2]. Init: zeros, gamma = 0.25.
 */

import type { ModelMatch } from "../types";

export interface FittedParams {
  /** Internal team ids; attack/defence arrays are aligned with this array. */
  teamIds: number[];
  attack: number[];
  defence: number[];
  homeAdv: number;
  rho: number;
}

export interface FitOptions {
  /** Adam iterations (default 1000; spec range 800–1200). */
  iterations?: number;
  /** Adam learning rate (default 0.05). */
  learningRate?: number;
  /** Time-decay rate per day (default 0.0018). */
  xi?: number;
  /** L2 penalty on attack/defence (default 1e-4). */
  l2?: number;
  /** Reference date for time decay; defaults to the latest match date. */
  referenceDate?: string;
}

export interface BivariateFitOptions extends FitOptions {
  /**
   * Apply the Dixon–Coles tau low-score correction and fit rho (default true).
   * Pass false for plain independent bivariate Poisson (e.g. the cards model);
   * rho then stays 0.
   */
  useTau?: boolean;
}

const DEFAULT_XI = 0.0018;
const DEFAULT_L2 = 1e-4;
const DEFAULT_ITERATIONS = 1000;
const DEFAULT_LR = 0.05;
const ADAM_B1 = 0.9;
const ADAM_B2 = 0.999;
const ADAM_EPS = 1e-8;
const TAU_FLOOR = 1e-8;
const RHO_LIMIT = 0.2;
const PARAM_LIMIT = 3;
const GAMMA_LIMIT = 1;
const ETA_MIN = -8;
const ETA_MAX = 4;
const MS_PER_DAY = 86_400_000;

// Log-factorials, computed lazily (goals beyond 20 are absurd but handled).
const LOG_FACT: number[] = [0];
function logFactorial(n: number): number {
  for (let i = LOG_FACT.length; i <= n; i++) {
    LOG_FACT.push(LOG_FACT[i - 1] + Math.log(i));
  }
  return LOG_FACT[n];
}

/** Poisson probability mass function. */
export function poissonPmf(lambda: number, k: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  const lam = Math.max(lambda, 1e-12);
  return Math.exp(-lam + k * Math.log(lam) - logFactorial(k));
}

/** Dixon–Coles low-score correction factor. */
export function tau(x: number, y: number, lambda: number, mu: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Fit the model on finished matches. Requires at least one match; with very
 * few matches the L2 penalty keeps parameters near zero (weak but sane).
 */
export function fitDixonColes(matches: ModelMatch[], opts: FitOptions = {}): FittedParams {
  return fitBivariatePoisson(matches, { ...opts, useTau: true });
}

/**
 * Shared optimizer core: bivariate Poisson with per-team attack/defence,
 * home advantage, exponential time decay, L2 penalty, full-batch Adam,
 * alpha re-centered to sum 0 after each iteration. With `useTau: false`
 * this is a plain independent Poisson fit (rho stays 0).
 */
export function fitBivariatePoisson(matches: ModelMatch[], opts: BivariateFitOptions = {}): FittedParams {
  const useTau = opts.useTau ?? true;
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const lr = opts.learningRate ?? DEFAULT_LR;
  const xi = opts.xi ?? DEFAULT_XI;
  const l2 = opts.l2 ?? DEFAULT_L2;
  if (matches.length === 0) {
    throw new Error("fitBivariatePoisson: need at least one match");
  }

  const teamIds = [...new Set(matches.flatMap((m) => [m.homeTeamId, m.awayTeamId]))].sort((a, b) => a - b);
  const teamIndex = new Map<number, number>(teamIds.map((id, i) => [id, i]));
  const n = teamIds.length;

  // Precompute per-match constants: indices, goals, time-decay weight.
  const refMs = opts.referenceDate
    ? Date.parse(opts.referenceDate)
    : Math.max(...matches.map((m) => Date.parse(m.utcDate)));
  const rows = matches.map((m) => {
    const daysAgo = Math.max(0, (refMs - Date.parse(m.utcDate)) / MS_PER_DAY);
    return {
      h: teamIndex.get(m.homeTeamId) as number,
      a: teamIndex.get(m.awayTeamId) as number,
      x: m.homeGoals,
      y: m.awayGoals,
      w: Math.exp(-xi * daysAgo),
    };
  });

  // Parameters: alpha[n], beta[n], gamma, rho.
  const alpha = new Float64Array(n);
  const beta = new Float64Array(n);
  let gamma = 0.25;
  let rho = 0;

  // Gradients and Adam moments.
  const gA = new Float64Array(n);
  const gB = new Float64Array(n);
  const mA = new Float64Array(n);
  const mB = new Float64Array(n);
  const vA = new Float64Array(n);
  const vB = new Float64Array(n);
  let mG = 0;
  let vG = 0;
  let mR = 0;
  let vR = 0;
  let b1pow = 1;
  let b2pow = 1;

  const adam = (p: number, g: number, m: number, v: number): [number, number, number] => {
    const gn = Number.isFinite(g) ? g : 0;
    const mN = ADAM_B1 * m + (1 - ADAM_B1) * gn;
    const vN = ADAM_B2 * v + (1 - ADAM_B2) * gn * gn;
    const step = (lr * (mN / (1 - b1pow))) / (Math.sqrt(vN / (1 - b2pow)) + ADAM_EPS);
    const pN = p + step;
    return [Number.isFinite(pN) ? pN : p, mN, vN];
  };

  for (let t = 1; t <= iterations; t++) {
    gA.fill(0);
    gB.fill(0);
    let gG = 0;
    let gR = 0;

    for (const { h, a, x, y, w } of rows) {
      const etaH = clamp(alpha[h] - beta[a] + gamma, ETA_MIN, ETA_MAX);
      const etaA = clamp(alpha[a] - beta[h], ETA_MIN, ETA_MAX);
      const lambda = Math.exp(etaH);
      const mu = Math.exp(etaA);

      // Poisson part: d logP / d eta = (goals - expected).
      const dH = x - lambda; // wrt eta_h (alpha_h, -beta_a, gamma)
      const dA = y - mu; //     wrt eta_a (alpha_a, -beta_h)
      let gAlphaH = dH;
      let gBetaA = -dH;
      let gGamma = dH;
      let gAlphaA = dA;
      let gBetaH = -dA;
      let gRho = 0;

      // Dixon–Coles tau part (only for scores 0-0, 1-0, 0-1, 1-1).
      if (useTau && x <= 1 && y <= 1) {
        let t: number;
        let dtLam: number;
        let dtMu: number;
        let dtRho: number;
        if (x === 0 && y === 0) {
          t = 1 - lambda * mu * rho;
          dtLam = -mu * rho;
          dtMu = -lambda * rho;
          dtRho = -lambda * mu;
        } else if (x === 1 && y === 0) {
          t = 1 + mu * rho;
          dtLam = 0;
          dtMu = rho;
          dtRho = mu;
        } else if (x === 0) {
          t = 1 + lambda * rho;
          dtLam = rho;
          dtMu = 0;
          dtRho = lambda;
        } else {
          t = 1 - rho;
          dtLam = 0;
          dtMu = 0;
          dtRho = -1;
        }
        // Guard: tau <= 0 would make log(tau) undefined — clamp the value,
        // skip its gradient contribution for that match.
        if (t > TAU_FLOOR) {
          const invT = 1 / t;
          const dLam = dtLam * lambda * invT; // d log(tau) / d eta_h
          const dMu = dtMu * mu * invT; //       d log(tau) / d eta_a
          gAlphaH += dLam;
          gBetaA -= dLam;
          gGamma += dLam;
          gAlphaA += dMu;
          gBetaH -= dMu;
          gRho = dtRho * invT;
        }
      }

      gA[h] += w * gAlphaH;
      gB[a] += w * gBetaA;
      gG += w * gGamma;
      gA[a] += w * gAlphaA;
      gB[h] += w * gBetaH;
      gR += w * gRho;
    }

    // L2 penalty: objective -= l2 * sum(alpha^2 + beta^2).
    for (let i = 0; i < n; i++) {
      gA[i] -= 2 * l2 * alpha[i];
      gB[i] -= 2 * l2 * beta[i];
    }

    b1pow *= ADAM_B1;
    b2pow *= ADAM_B2;

    for (let i = 0; i < n; i++) {
      const [aN, mAN, vAN] = adam(alpha[i], gA[i], mA[i], vA[i]);
      alpha[i] = clamp(aN, -PARAM_LIMIT, PARAM_LIMIT);
      mA[i] = mAN;
      vA[i] = vAN;
      const [bN, mBN, vBN] = adam(beta[i], gB[i], mB[i], vB[i]);
      beta[i] = clamp(bN, -PARAM_LIMIT, PARAM_LIMIT);
      mB[i] = mBN;
      vB[i] = vBN;
    }
    const [gN, mGN, vGN] = adam(gamma, gG, mG, vG);
    gamma = clamp(gN, -GAMMA_LIMIT, GAMMA_LIMIT);
    mG = mGN;
    vG = vGN;
    const [rN, mRN, vRN] = adam(rho, gR, mR, vR);
    rho = clamp(rN, -RHO_LIMIT, RHO_LIMIT);
    mR = mRN;
    vR = vRN;

    // Identifiability: re-center attack ratings to sum 0.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += alpha[i];
    mean /= n;
    for (let i = 0; i < n; i++) alpha[i] -= mean;
  }

  return {
    teamIds,
    attack: Array.from(alpha),
    defence: Array.from(beta),
    homeAdv: gamma,
    rho,
  };
}

function expectedGoals(params: FittedParams, homeTeamId: number, awayTeamId: number): { lambda: number; mu: number } {
  const h = params.teamIds.indexOf(homeTeamId);
  const a = params.teamIds.indexOf(awayTeamId);
  if (h === -1 || a === -1) {
    throw new Error(`predictScoreGrid: team not in fitted params (home=${homeTeamId}, away=${awayTeamId})`);
  }
  const lambda = Math.exp(clamp(params.attack[h] - params.defence[a] + params.homeAdv, ETA_MIN, ETA_MAX));
  const mu = Math.exp(clamp(params.attack[a] - params.defence[h], ETA_MIN, ETA_MAX));
  return { lambda, mu };
}

/**
 * Probability grid P(home=x, away=y) for x,y in 0..maxGoals (default 10),
 * with the tau correction applied, normalized to sum to 1.
 * Indexed grid[x][y].
 */
export function predictScoreGrid(
  params: FittedParams,
  homeTeamId: number,
  awayTeamId: number,
  maxGoals = 10,
): number[][] {
  const { lambda, mu } = expectedGoals(params, homeTeamId, awayTeamId);
  const grid: number[][] = [];
  let sum = 0;
  for (let x = 0; x <= maxGoals; x++) {
    const row: number[] = [];
    for (let y = 0; y <= maxGoals; y++) {
      const t = Math.max(tau(x, y, lambda, mu, params.rho), TAU_FLOOR);
      const p = poissonPmf(lambda, x) * poissonPmf(mu, y) * t;
      row.push(p);
      sum += p;
    }
    grid.push(row);
  }
  if (!(sum > 0) || !Number.isFinite(sum)) {
    // Degenerate fallback: uniform grid (should never happen given clamps).
    const u = 1 / ((maxGoals + 1) * (maxGoals + 1));
    return Array.from({ length: maxGoals + 1 }, () => Array.from({ length: maxGoals + 1 }, () => u));
  }
  for (let x = 0; x <= maxGoals; x++) {
    for (let y = 0; y <= maxGoals; y++) {
      grid[x][y] /= sum;
    }
  }
  return grid;
}

/** Raw expected goals (before tau), exposed for reporting. */
export function predictExpectedGoals(
  params: FittedParams,
  homeTeamId: number,
  awayTeamId: number,
): { lambda: number; mu: number } {
  return expectedGoals(params, homeTeamId, awayTeamId);
}
