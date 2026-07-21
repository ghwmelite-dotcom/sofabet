/**
 * Sofabet worker entry: JSON API router + cron jobs.
 * - Daily  (17 4 * * *):  sync all leagues, refit + cache goals params.
 * - Hourly (47 * * * *):  backfill bookings (match_stats) for recent finished
 *   matches, throttled, 70 per run.
 */

import { handleRequest } from "./api/routes";
import { LEAGUES } from "./config";
import { FootballDataClient } from "./data/footballData";
import { syncAllLeagues } from "./data/sync";
import { syncStatsBatch } from "./data/syncStats";
import { refitLeague } from "./model/service";
import { StatsRestrictedError } from "./types";

const DAILY_CRON = "17 4 * * *";
const HOURLY_CRON = "47 * * * *";
const HOURLY_STATS_LIMIT = 70;

async function runDaily(env: Env, cron: string): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log(JSON.stringify({ message: "daily job started", cron, startedAt }));

  const token = env.FOOTBALL_DATA_TOKEN;
  if (token) {
    const results = await syncAllLeagues(env.DB, token, 1);
    const okCount = results.filter((r) => r.ok).length;
    console.log(JSON.stringify({ message: "daily sync done", ok: okCount, failed: results.length - okCount }));
  } else {
    console.error(JSON.stringify({ message: "FOOTBALL_DATA_TOKEN not set; skipping sync, refit only" }));
  }

  for (const league of Object.keys(LEAGUES)) {
    try {
      const meta = await refitLeague(env.DB, league);
      console.log(JSON.stringify({ message: "league refit", league, refitted: meta !== null, meta }));
    } catch (e) {
      console.error(
        JSON.stringify({ message: "league refit failed", league, error: e instanceof Error ? e.message : String(e) }),
      );
    }
  }
  console.log(JSON.stringify({ message: "daily job finished" }));
}

async function runHourly(env: Env, cron: string): Promise<void> {
  const token = env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    console.log(JSON.stringify({ message: "hourly stats sync skipped", cron, reason: "FOOTBALL_DATA_TOKEN not set" }));
    return;
  }
  const client = new FootballDataClient(token);
  try {
    const result = await syncStatsBatch(env.DB, client, "all", HOURLY_STATS_LIMIT);
    console.log(JSON.stringify({ message: "hourly stats sync", cron, ...result }));
  } catch (e) {
    if (e instanceof StatsRestrictedError) {
      // Tier-restricted endpoint: nothing to backfill with — log and stop.
      console.error(JSON.stringify({ message: "hourly stats sync aborted: restricted", cron, error: e.message }));
      return;
    }
    throw e;
  }
}

async function runScheduled(env: Env, cron: string): Promise<void> {
  if (cron === DAILY_CRON) return runDaily(env, cron);
  if (cron === HOURLY_CRON) return runHourly(env, cron);
  console.log(JSON.stringify({ message: "scheduled event with unknown cron; ignored", cron }));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduled(env, event.cron).catch((e: unknown) => {
        console.error(
          JSON.stringify({ message: "scheduled job crashed", cron: event.cron, error: e instanceof Error ? e.message : String(e) }),
        );
      }),
    );
  },
} satisfies ExportedHandler<Env>;
