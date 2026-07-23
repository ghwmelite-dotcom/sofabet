/**
 * Bookings backfill pipeline: fetch per-match card stats from the
 * football-data.org match-detail endpoint for FINISHED matches that have no
 * match_stats row yet. Throttled by the client (1 call / 6.5s), newest first.
 *
 * Error policy:
 * - 429 rate limit: stop the batch gracefully and return what was stored.
 * - StatsRestrictedError (401/403, tier-restricted endpoint): abort and
 *   propagate — no placeholder rows are ever inserted.
 * - Anything else (e.g. 404 for a vanished match): log, count as failed,
 *   continue; the match stays pending and is retried on a later run.
 */

import { LEAGUES } from "../config";
import { FootballDataClient } from "./footballData";
import { countPendingStats, getPendingStatsMatches, insertMatchStats } from "./repo";
import { FootballDataError, StatsRestrictedError } from "../types";

export interface StatsSyncResult {
  scope: string;
  stored: number;
  failed: number;
  remaining: number;
  rateLimited: boolean;
}

/**
 * Filter a scope's leagues down to those the bookings pipeline can serve
 * (fdorg only — API-Football fixtures have no bookings on the fdorg
 * match-detail endpoint). Returns both lists for logging.
 */
export function statsEligibleLeagues(keys: string[]): { eligible: string[]; skipped: string[] } {
  const skipped = keys.filter((k) => LEAGUES[k] && LEAGUES[k].provider !== "fdorg");
  const eligible = keys.filter((k) => !LEAGUES[k] || LEAGUES[k].provider === "fdorg");
  return { eligible, skipped };
}

/**
 * Sync up to `limit` matches' bookings. `scope` is a league key or 'all'
 * ('all' covers the fdorg registry leagues, newest matches first across
 * them — API-Football leagues have no bookings source and are skipped).
 */
export async function syncStatsBatch(
  db: D1Database,
  client: FootballDataClient,
  scope: string,
  limit: number,
): Promise<StatsSyncResult> {
  const requested = scope === "all" ? Object.keys(LEAGUES) : [scope];
  const { eligible: leagues, skipped } = statsEligibleLeagues(requested);
  if (skipped.length > 0) {
    console.log(
      JSON.stringify({ message: "stats sync skips non-fdorg leagues (no bookings source)", leagues: skipped }),
    );
  }
  const pendingBefore = await countPendingStats(db, leagues);
  if (pendingBefore === 0 || limit <= 0) {
    return { scope, stored: 0, failed: 0, remaining: pendingBefore, rateLimited: false };
  }
  const pending = await getPendingStatsMatches(db, leagues, limit);
  let stored = 0;
  let failed = 0;
  let rateLimited = false;

  for (const match of pending) {
    try {
      const bookings = await client.getMatchBookings(match.api_id);
      await insertMatchStats(
        db,
        {
          matchId: match.id,
          homeYellow: bookings.homeYellow,
          awayYellow: bookings.awayYellow,
          homeRed: bookings.homeRed,
          awayRed: bookings.awayRed,
        },
        new Date().toISOString(),
      );
      stored++;
    } catch (e) {
      if (e instanceof StatsRestrictedError) {
        // Tier restriction won't fix itself by retrying — abort the batch.
        console.error(
          JSON.stringify({ message: "stats sync aborted: match detail restricted", error: e.message, stored }),
        );
        throw e;
      }
      if (e instanceof FootballDataError && e.status === 429) {
        console.warn(JSON.stringify({ message: "stats sync stopped: upstream rate limit", stored, failed }));
        rateLimited = true;
        break;
      }
      failed++;
      console.error(
        JSON.stringify({
          message: "stats fetch failed for match",
          matchId: match.id,
          apiId: match.api_id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  return { scope, stored, failed, remaining: pendingBefore - stored, rateLimited };
}
