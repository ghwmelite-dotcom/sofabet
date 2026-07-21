/**
 * football-data.org v4 API client. Free tier allows 10 requests/minute, so the
 * client self-throttles: every request waits until at least `minIntervalMs`
 * (default 6.5s) since the previous one.
 */

import { FootballDataError, StatsRestrictedError } from "../types";
import type { IngestedMatch } from "../types";

const BASE_URL = "https://api.football-data.org/v4";

interface FdTeam {
  id: number;
  name: string;
  shortName?: string;
}

interface FdMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday?: number;
  season?: { startDate?: string };
  homeTeam: FdTeam;
  awayTeam: FdTeam;
  score?: { fullTime?: { home?: number | null; away?: number | null } };
}

interface FdMatchesResponse {
  matches?: FdMatch[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FootballDataClient {
  private lastCallAt = 0;

  constructor(
    private readonly token: string,
    private readonly minIntervalMs = 6500,
  ) {}

  private async throttle(): Promise<void> {
    const wait = this.minIntervalMs - (Date.now() - this.lastCallAt);
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
  }

  /**
   * GET /competitions/{code}/matches[?season=YYYY]. Omit `season` for the
   * current season; pass the season start year (e.g. 2023) for past seasons.
   */
  async getCompetitionMatches(code: string, season?: number): Promise<IngestedMatch[]> {
    await this.throttle();
    const url =
      `${BASE_URL}/competitions/${encodeURIComponent(code)}/matches` +
      (season !== undefined ? `?season=${season}` : "");
    const res = await fetch(url, {
      headers: { "X-Auth-Token": this.token, Accept: "application/json" },
    });
    if (!res.ok) {
      const retryAfter = res.headers.get("Retry-After");
      await res.body?.cancel();
      throw new FootballDataError(
        `football-data.org responded ${res.status} for competition ${code}` +
          (season !== undefined ? ` season ${season}` : "") +
          (res.status === 429 ? " (rate limited — free tier is 10 requests/minute)" : ""),
        res.status,
        retryAfter !== null ? Number(retryAfter) : undefined,
      );
    }
    // Bounded payload (one season of fixtures); safe to buffer.
    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) {
      throw new FootballDataError(`football-data.org returned a non-object payload for ${code}`, res.status);
    }
    const matches = (data as FdMatchesResponse).matches;
    if (!Array.isArray(matches)) {
      throw new FootballDataError(`football-data.org payload for ${code} has no matches array`, res.status);
    }
    return matches.map(toIngestedMatch);
  }

  /**
   * GET /matches/{id} — match detail with bookings. Tier-restricted on
   * football-data.org: 401/403 throws StatsRestrictedError, 429 throws
   * FootballDataError (rate limit).
   *
   * Card-counting convention: a YELLOW_RED_CARD (second yellow) counts as
   * BOTH a yellow and a red. Matching is by substring, so any card string
   * containing "YELLOW" adds a yellow and any containing "RED" adds a red.
   */
  async getMatchBookings(matchId: number): Promise<MatchBookings> {
    await this.throttle();
    const url = `${BASE_URL}/matches/${matchId}`;
    const res = await fetch(url, {
      headers: { "X-Auth-Token": this.token, Accept: "application/json" },
    });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new StatsRestrictedError(
        `football-data.org match detail endpoint is restricted on your tier (${res.status})`,
        res.status,
      );
    }
    if (!res.ok) {
      const retryAfter = res.headers.get("Retry-After");
      await res.body?.cancel();
      throw new FootballDataError(
        `football-data.org responded ${res.status} for match ${matchId}` +
          (res.status === 429 ? " (rate limited — free tier is 10 requests/minute)" : ""),
        res.status,
        retryAfter !== null ? Number(retryAfter) : undefined,
      );
    }
    // Bounded payload (one match detail); safe to buffer.
    const data: unknown = await res.json();
    return parseMatchBookings(data, matchId);
  }
}

export interface MatchBookings {
  homeYellow: number;
  awayYellow: number;
  homeRed: number;
  awayRed: number;
}

interface FdBooking {
  card?: string;
  team?: { id?: number };
}

interface FdMatchDetail {
  homeTeam?: { id?: number };
  awayTeam?: { id?: number };
  bookings?: FdBooking[];
}

function parseMatchBookings(data: unknown, matchId: number): MatchBookings {
  if (typeof data !== "object" || data === null) {
    throw new FootballDataError(`football-data.org returned a non-object payload for match ${matchId}`, 200);
  }
  // The v4 detail endpoint returns the match at top level; tolerate a
  // `{ match: {...} }` wrapper as well.
  const root = data as Record<string, unknown>;
  const detail = (typeof root.match === "object" && root.match !== null ? root.match : root) as FdMatchDetail;
  const homeId = detail.homeTeam?.id;
  const awayId = detail.awayTeam?.id;
  if (typeof homeId !== "number" || typeof awayId !== "number") {
    throw new FootballDataError(`football-data.org match ${matchId} detail is missing team ids`, 200);
  }
  const bookings = Array.isArray(detail.bookings) ? detail.bookings : [];
  const out: MatchBookings = { homeYellow: 0, awayYellow: 0, homeRed: 0, awayRed: 0 };
  for (const b of bookings) {
    const card = typeof b.card === "string" ? b.card : "";
    const teamId = b.team?.id;
    const isHome = teamId === homeId;
    const isAway = teamId === awayId;
    if (!isHome && !isAway) continue;
    if (card.includes("YELLOW")) {
      if (isHome) out.homeYellow++;
      else out.awayYellow++;
    }
    if (card.includes("RED")) {
      if (isHome) out.homeRed++;
      else out.awayRed++;
    }
  }
  return out;
}

function toIngestedMatch(m: FdMatch): IngestedMatch {
  return {
    apiId: m.id,
    season: m.season?.startDate ? m.season.startDate.slice(0, 4) : "",
    utcDate: m.utcDate,
    matchday: m.matchday ?? null,
    status: m.status,
    homeApiId: m.homeTeam.id,
    homeName: m.homeTeam.name,
    homeShortName: m.homeTeam.shortName ?? null,
    awayApiId: m.awayTeam.id,
    awayName: m.awayTeam.name,
    awayShortName: m.awayTeam.shortName ?? null,
    homeGoals: m.score?.fullTime?.home ?? null,
    awayGoals: m.score?.fullTime?.away ?? null,
  };
}
