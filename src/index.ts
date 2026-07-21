/**
 * Sofabet worker entry: JSON API router + daily cron (sync all leagues, then
 * refit and cache each league's Dixon–Coles params).
 */

import { handleRequest } from "./api/routes";
import { LEAGUES } from "./config";
import { syncAllLeagues } from "./data/sync";
import { refitLeague } from "./model/service";

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runDaily(env, event.cron).catch((e: unknown) => {
        console.error(
          JSON.stringify({ message: "daily job crashed", error: e instanceof Error ? e.message : String(e) }),
        );
      }),
    );
  },
} satisfies ExportedHandler<Env>;
