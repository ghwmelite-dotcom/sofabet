# Sofabet

Football (soccer) match-outcome probabilities from a Dixon–Coles model, served
as a JSON API on Cloudflare Workers + D1. Match results are ingested from the
[football-data.org](https://www.football-data.org/) API; a per-league
Dixon–Coles model (attack/defence ratings per team, home advantage, low-score
correlation, exponential time decay) is fitted in the Worker, and the API
serves 1X2 / BTTS / over-under / correct-score / double-chance / draw-no-bet /
team-total / asian & european handicap probabilities, expected goals, a
yellow-cards model, team ratings, and walk-forward backtests.

## What this is NOT

- **No profit guarantees.** Model output is probabilities, nothing more. Any
  "value" comes from comparing those probabilities against bookmaker odds —
  the model can be and often will be wrong.
- **No auto-betting and no betting-platform integration.** This project
  computes and serves numbers; it never places wagers.
- **Not live.** Data comes from a free API on a daily sync cadence.

## Data limits (football-data.org free tier)

- 10 requests/minute — the client self-throttles to one call per 6.5s, so a
  full `league=all` sync takes minutes by design.
- The 8 registered leagues (PL, ELC, BL1, SA, PD, FL1, DED, PPL) are on the
  free tier. Smaller competitions (e.g. Turkish or Belgian leagues) are NOT
  covered by the free tier.
- The set of free-tier competitions can change at any time; old seasons for a
  competition may also be unavailable. Failed season fetches are logged and
  skipped.

## Setup (production)

```bash
npm install
# 1. Free API token: https://www.football-data.org/client/register
# 2. Cloudflare auth + D1:
npx wrangler login
npx wrangler d1 create sofabet-db
#    -> paste the printed database_id into wrangler.jsonc (replaces the placeholder)
npx wrangler secret put FOOTBALL_DATA_TOKEN
npx wrangler d1 migrations apply sofabet-db --remote
npx wrangler deploy
# 3. Load data (one open request, throttled to <10 req/min; takes ~2-3 min):
curl -X POST -H "Authorization: Bearer <SYNC_KEY>" \
  "https://<your-worker>.workers.dev/api/sync?league=all&seasons=2"
# 4. Use the API, e.g.:
curl "https://<your-worker>.workers.dev/api/predict?league=PL&home=Arsenal&away=Chelsea"
```

A daily cron (04:17 UTC) syncs all leagues and refits every goals model into
`model_cache`; an hourly cron (:47) backfills bookings (see "Cards data").

## Local dev

```bash
cp .dev.vars.example .dev.vars   # put your real token in .dev.vars (gitignored)
npx wrangler d1 migrations apply sofabet-db --local
npx wrangler d1 execute sofabet-db --local --file=scripts/seed_dev.sql  # synthetic TEST league
npm run dev                      # http://localhost:8787
```

`scripts/seed_dev.sql` loads a synthetic 12-team league `TEST` (300 finished
matches + 6 scheduled fixtures) so every endpoint works locally without an API
token. `npm run types` regenerates `worker-configuration.d.ts` (also picks up
secret names from `.dev.vars`); `npm test` runs the model unit tests;
`npm run typecheck` runs `tsc --noEmit`.

## API reference

All responses are JSON. Errors are `{"error": "..."}` with a sensible status.

| Method & path | Description |
|---|---|
| `GET /api/health` | `{ok: true}` |
| `GET /api/leagues` | League registry + per-league match counts in D1 |
| `POST /api/sync?league=PL[&seasons=2]` | Sync one league from football-data.org. Requires `Authorization: Bearer <SYNC_KEY>` when that secret is set. `league=all` syncs every league in one held-open request (throttled to <10 req/min, ~2-3 min). `seasons=N` also fetches N-1 previous seasons (backtest depth) |
| `POST /api/sync-stats?league=PL[&limit=70]` | SYNC_KEY-protected, synchronous. Backfills bookings (`match_stats`) for up to `limit` FINISHED matches without stats, newest first (~6.5s/match). Returns `{stored, failed, remaining, rateLimited}`. Upstream 429 stops the batch gracefully (partial counts); a tier-restricted detail endpoint returns 403 `{restricted: true}` and inserts nothing |
| `GET /api/stats-coverage` | Per league: finished match count, matches with bookings, coverage pct |
| `GET /api/fixtures?league=PL` | Scheduled fixtures from D1 with model predictions attached (1X2, BTTS, O2.5, xG, most likely score, double chance, AH −0.5/+0.5) |
| `GET /api/predict?league=PL&home=<name\|id>&away=<name\|id>` | Full markets: 1X2, BTTS, over/under 0.5–4.5, top 5 correct scores, double chance, draw-no-bet (with fair odds), team totals 0.5–3.5, asian handicap ladder −2..+2 step 0.25 (quarter lines = half-stake averages; fairOdds = (1−pPush)/pWin), european handicap −2..+2; expected goals; model freshness. Plus a `cards` block (expected yellows, total O/U 1.5–6.5, per-team O/U 1.5/2.5) once the league has ≥ 60 matches with bookings — otherwise `cards: null` with a `cardsCoverage` note |
| `GET /api/model/:league[?kind=goals\|cards]` | Fitted ratings table (attack/defence per team, home advantage, rho, fitted_at, match_count). `kind=cards` returns the yellow-card ratings fitted on `match_stats` |
| `GET /api/backtest?league=PL` | Walk-forward backtest: log loss / Brier / RPS for model vs base-rate baseline vs uniform, decile calibration table |

## Cards data

Bookings come from the football-data.org **match-detail endpoint**
(`GET /v4/matches/{id}`, one call per match) — availability depends on your
plan tier; a 401/403 there aborts the batch cleanly and nothing is stored.
An hourly cron (`47 * * * *`) backfills up to 70 matches per run, newest
first, so the ~5,500 historical matches take roughly **3 days** to fully
backfill (`POST /api/sync-stats?league=all&limit=200` speeds it up manually).
Counting convention: a `YELLOW_RED_CARD` (second yellow) counts as both a
yellow and a red. **Corners and fouls are NOT available from
football-data.org at any tier**, so there is no corners/fouls model.

## Model summary

Goals — per league, finished matches only. Parameters: attack α_i and defence
β_i per team, home advantage γ, low-score correlation ρ (clamped to ±0.2).
λ = exp(α_home − β_away + γ), μ = exp(α_away − β_home). Weighted
log-likelihood with the Dixon–Coles τ correction for 0-0/1-0/0-1/1-1, time
decay exp(−0.0018·days), L2 penalty 1e-4, fitted by full-batch Adam
(lr 0.05, ~1000 iterations), α re-centered to sum 0 each iteration.
Predictions use an 11×11 normalized score grid. Cached in D1 (`model_cache`,
kind `goals`) and reused while fresh (< 6h and same finished-match count);
otherwise refit on demand.

Cards — same fitting shape but plain independent Poisson (no τ/ρ) on yellow
counts: `cardsAttack` (tendency to collect yellows), `cardsDefence` (tendency
to make opponents collect yellows), `cardsHomeAdv`. Shares the goals
optimizer core (`fitBivariatePoisson` with `useTau: false`). Predictions use a
13×13 (0..12) yellow grid; cached as kind `cards` with the same freshness
rule keyed on the number of matches with bookings.

Backtest: burn-in on the first 60 matches, then refit every 8 matches on an
expanding window and predict the next block. Needs ≥ 150 finished matches.
