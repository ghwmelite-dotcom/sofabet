# Sofabet

Football (soccer) match-outcome probabilities from a Dixon–Coles model, served
as a JSON API on Cloudflare Workers + D1. The UI's design system (tokens,
typography, checklist) lives in `design-system/sofabet/MASTER.md` — the PWA
implements it as an OLED-dark skin with self-hosted Fira Sans/Fira Code fonts
(regenerate them with `npm run fonts`). Match results are ingested from the
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
npx wrangler secret put SYNC_KEY            # protects sync + bets endpoints
npx wrangler secret put ODDS_API_KEY        # optional; odds/value finder
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
| `POST /api/sync-odds?league=PL[&markets=h2h,totals]` | SYNC_KEY-protected, synchronous. Fetches the-odds-api events for the league, matches them to D1 fixtures (name normalization + 3h kickoff window), aggregates bookmaker prices (consensus = mean, best = max, count) and stores one snapshot per outcome with model probability and EV. One quota unit per market requested. Returns events/matched/unmatched/snapshots + quota headers |
| `GET /api/value?league=PL[&minEv=0.04]` | +EV opportunities from the latest snapshots of not-yet-started matches: ev_pct ≥ minEv, model_prob ≥ 0.15, ≥ 3 bookmakers, sorted by EV desc. 400 `no_odds_synced` when the league has no snapshots yet |
| `GET /api/fixtures?league=PL` | Scheduled fixtures from D1 with model predictions attached (1X2, BTTS, O2.5, xG, most likely score, double chance, AH −0.5/+0.5) |
| `GET /api/predict?league=PL&home=<name\|id>&away=<name\|id>` | Full markets: 1X2, BTTS, over/under 0.5–4.5, top 5 correct scores, double chance, draw-no-bet (with fair odds), team totals 0.5–3.5, asian handicap ladder −2..+2 step 0.25 (quarter lines = half-stake averages; fairOdds = (1−pPush)/pWin), european handicap −2..+2; expected goals; model freshness. Plus a `cards` block (expected yellows, total O/U 1.5–6.5, per-team O/U 1.5/2.5) once the league has ≥ 60 matches with bookings — otherwise `cards: null` with a `cardsCoverage` note |
| `GET /api/model/:league[?kind=goals\|cards]` | Fitted ratings table (attack/defence per team, home advantage, rho, fitted_at, match_count). `kind=cards` returns the yellow-card ratings fitted on `match_stats` |
| `GET /api/backtest?league=PL` | Walk-forward backtest: log loss / Brier / RPS for model vs base-rate baseline vs uniform, decile calibration table |
| `GET /api/form?league=PL&team=<id\|name>` | Team form: last 5 finished matches (opponent, venue, score, W/D/L) newest first, plus gf/ga totals overall and over the last 5 home / last 5 away games |
| `GET /api/results?league=PL[&days=14]` | Graded track record: FINISHED matches INNER JOIN their pre-kickoff prediction snapshots (1X2 predicted side + hit, O2.5/BTTS/top-score hits, logLoss, Brier), newest first, plus aggregate summary. `days` 1–60. 200 with a `note` when no snapshots exist yet |
| `POST /api/predictions/snapshot?league=PL` | SYNC_KEY-protected. Force a pre-kickoff snapshot write for the league outside the daily cron (e.g. right after a manual fixture sync) |

## PWA + bet tracker

The worker serves an installable PWA (vanilla JS, no build step) from
`./public` via Workers Static Assets: `/api/*` runs the Worker
(`run_worker_first`), everything else serves static files, and unknown
non-API GET paths fall back to `index.html` (SPA). Open the worker URL in a
browser and use the **Install** button (or the browser's install affordance).

Screens (bottom tab bar on mobile, header tabs on desktop): fixtures (team
crests, segmented 1X2 bar, "+ bet" shortcut; lands on the first league with
fixtures inside 7 days, kickoffs in device-local time), value (+EV list with
odds refresh), match detail (all markets incl. handicaps + cards), ratings,
accuracy (lazy per-league backtests with a calibration chart), and bets.

**Bet tracker** (all `/api/bets*` routes require
`Authorization: Bearer <SYNC_KEY>` — stake data is private; the PWA asks for
the key once and keeps it in localStorage):

| Method & path | Description |
|---|---|
| `GET /api/bets?status=open\|settled\|all` | List bets, newest first |
| `POST /api/bets` | Create `{league?, matchId?, matchLabel, bookmaker, market, selection, line?, odds, stake}` (odds > 1, stake > 0) |
| `POST /api/bets/:id/settle` | `{result: won\|lost\|void}` — profit = stake·(odds−1) / −stake / 0 |
| `POST /api/bets/:id/delete` | Remove a bet |
| `POST /api/bets/autosettle` | Settles open match-linked bets whose match is FINISHED, evaluating 1X2 / doubleChance / overUnder (exact-line = void) / btts against the score; unsupported markets are reported as skipped |
| `GET /api/bets/summary` | Staked, profit, ROI%, strike rate, status counts, breakdowns by bookmaker and market |

The tracker records **manual** bets for personal record-keeping; the project
still never places wagers anywhere.

## Odds data (+EV value finder)

Bookmaker prices come from [the-odds-api](https://the-odds-api.com/) v4
(key in the `ODDS_API_KEY` secret). Free tier is **500 requests/month** and
usage is per market per request: `h2h` costs 1 unit, `h2h,totals` costs 2
units per league call. The daily cron syncs **h2h only** for all 8 leagues —
8 units/day ≈ 240/month — leaving headroom; totals are synced on demand via
`POST /api/sync-odds?league=X&markets=h2h,totals` or the PWA's "Refresh odds"
button. Latest quota headers are persisted in `meta` and shown in the PWA.

Requests use `regions=eu`. Note that SportyBet/1xBet prices aren't listed on
the-odds-api — we compare the model against the **EU market consensus + best
available price**, which is the standard sharp reference (1xBet's EU prices
track that consensus closely). Sport keys are resolved dynamically from
`/sports` by title and cached in `meta` (refetched if a cached key 404s).

EV definition: `evPct = modelProb × bestOdds − 1` — best price is what you
can actually take; consensus is shown for context. Value rows additionally
require modelProb ≥ 0.15 and ≥ 3 bookmakers.

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

Track record (the "Record" tab): the daily cron snapshots pre-kickoff
predictions into `predictions` right after each league's refit. Grading uses
ONLY those frozen snapshots — never a recomputed "what the model would have
said", because after a result is ingested the model may refit on it and the
record would be backfitted. Matches that finished before this feature shipped
have no snapshot and stay ungraded: the record starts empty and accumulates
from deploy day.
