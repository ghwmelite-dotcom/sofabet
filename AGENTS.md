# Sofabet — Project Memory

Football match-outcome probability platform: Dixon–Coles model on Cloudflare Workers + D1, vanilla-JS PWA, value-bet finder against bookmaker odds, manual bet tracker, self-grading prediction track record. Owner's GitHub: `ghwmelite-dotcom/sofabet`. Live: `https://sofabet.ghwmelite.workers.dev`.

## Hard boundaries (owner-mandated, do not cross)
- **No auto-betting, ever.** No integration with SportyBet/1xBet or any bookmaker. The tool informs; the user places bets manually.
- **No profit promises.** Model output is probabilities; honesty about uncertainty is a design requirement, not a disclaimer.
- **No SofaScore scraping** (unlicensed, ToS-gray). No scraping generally — licensed/free sources only.

## Stack & invariants
- Cloudflare Workers + D1 + Workers Static Assets (SPA in `public/`). **Zero runtime dependencies** (devDeps: wrangler, typescript, vitest). Vanilla TS/JS/CSS, no build step, **zero external runtime requests** (fonts self-hosted in `public/fonts/`).
- Always `npx tsc --noEmit && npx vitest run` green before commit; `npm run types` after binding changes; `wrangler deploy --dry-run` to validate.
- Migrations numbered sequentially in `migrations/` (0001–0005 applied).
- **Bump the service-worker cache name on EVERY `public/` change** (currently `sofabet-shell-v11`) or phones keep stale shells.
- After `wrangler deploy`, workers.dev can take **up to ~60s to propagate** — re-check before assuming a deploy failed.

## Secrets (in Cloudflare; names only — values never in repo/chat)
- `FOOTBALL_DATA_TOKEN` — football-data.org free tier (10 req/min; client self-throttles 6.5s).
- `ODDS_API_KEY` — the-odds-api free tier (500 req/month; cost = #markets/request; quota headers persisted in `meta` table).
- `SYNC_KEY` — admin bearer key protecting `POST /api/sync*` and all `/api/bets*`.
- `API_FOOTBALL_KEY` — currently USELESS: free plan walls seasons at 2022–2024 (client kept for a future paid tier).

## Data providers (league registry in `src/config.ts`, `provider` + `tier` fields)
- **fdorg** (football-data.org): the 6 majors PL, PD, SA, BL1, FL1, BSA. NOTE: it uses **placeholder kickoff dates/times** on unconfirmed fixtures (whole matchday at 15:00Z) — event matching must tolerate multi-day drift (a league pair is unique per season; 72h window only arbitrates duplicates).
- **fduk** (football-data.co.uk CSVs, keyless, 2×weekly): 12 minors — SWE, NOR, FIN, ARG, IRL, AUT, SUI, POL, DEN, CHN, MEX, MLS. League files `/new/{CODE}.csv` (results incl. closing odds — earmarked for "backtest vs real prices"); upcoming fixtures from `/fixtures.csv` (Fri/Tue cycle, can be empty off-cycle). Synthetic deterministic ids (FNV-1a + 8e9 offset) with results↔fixtures same-match invariant. Season labels: single-year (summer) and slash (winter); style follows the MOST RECENT label.
- **the-odds-api**: regions=eu; sport keys PINNED per league (title resolution once matched "Premier League"→Russia). Catalog has NO Romania/Japan/Russia coverage (checked live; ROU/JPN dropped, RUS excluded). `/api/odds-sports` (SYNC_KEY) lists the live catalog.
- Removed leagues (ELC, DED, PPL) keep frozen D1 data; restore = one registry line.

## Model & features
- `src/model/dixonColes.ts`: per-league attack/defence ratings + home adv + rho, time decay ξ=0.0018, Adam fit, 11×11 score grid → all markets (1X2, DC, DNB, O/U 0.5–4.5 match+team, BTTS, AH ±2 step 0.25 quarter-averaged, EH, correct scores). Cards model = independent Poisson on yellow cards (fdorg leagues only).
- Backtests (walk-forward) beat base-rate baseline almost everywhere; weakest: ARG/POL (model LOSES), BSA/MLS/SUI marginal. Best: CHN, MEX, PPL, SA.
- Odds pipeline: event↔fixture matching (normalize: diacritics, "and", club tokens fc/afc/…, exonym aliases munich~munchen; token-subset align + fuzzy prefix ≥4; unique-pair acceptance). Snapshots → `odds_snapshots`; `/api/value` flags ev ≥ 4%, prob ≥ 15%, books ≥ 3.
- **Track record** (`predictions` table): snapshots of pre-kickoff predictions, refreshed daily until kickoff then FROZEN (anti-backfit rule); `/api/results` grades hit rates + logLoss/Brier; "Record" tab in PWA.
- **ACCA v2** (`/api/acca`): highest-probability leg per match across 1X2/DC/totals/BTTS, floors prob ≥ 0.55 & ev ≥ −0.03; price tiers market/derived(d)/model(~); EV pill only when all legs priced. **Rollover**: one pick/day, prob ≥ 0.45, cumulative path. `?debug=1` instruments it.
- Odds cadence: majors daily, minors rotate 4/day (300/month quota).
- Bets tracker: SYNC_KEY-gated, autosettle for 1X2/DC/O-U/BTTS.

## Ops lessons (hard-won, don't relearn)
- `ctx.waitUntil()` post-response work is cut at ~30s — long loops must stay inside the request (sync endpoints are synchronous by design).
- Deploy propagation lag up to ~60s; D1 `meta` table holds quota + sport-map caches.
- PWA key flow: localStorage `sofabet_key`; Value screen is key-free to view, key only for refresh.

## Pending / roadmap (as of 2026-07-23)
- fixtures.csv Friday refresh → minor-league fixtures/odds/value light up.
- Cron task `0dbbddf5` (one-shot, 2026-07-24 10:03 UTC): first track-record check on Brazil results.
- Roadmap priority: calibration (confidence-weighted value ranking, shrink toward consensus, promoted-team annotations), CLV tracking vs closing price, weekly report, Telegram alerts, Kelly staking. Cards backtest pending. Backtest vs fduk closing odds (files already contain them).
- Design system: `design-system/sofabet/MASTER.md` (ui-ux-pro-max skill output; Kinetic Brutalism adapted — acid #DFE104 on #09090B, Space Grotesk/Fira Sans/Fira Code self-hosted). Skill tooling in `.claude/` is gitignored.
