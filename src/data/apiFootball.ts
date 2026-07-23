/**
 * API-Football (api-sports.io) v3 client — match-data provider for the Nordic
 * leagues (SWE/DEN/NOR/FIN). Free tier = 100 requests/day, guarded locally at
 * 95 with a D1 meta counter (`af_calls_YYYY-MM-DD`, UTC date) that rolls over
 * daily. Key from the API_FOOTBALL_KEY secret, header `x-apisports-key`.
 *
 * ID namespacing: API-Football numeric ids overlap football-data.org's id
 * space, and our matches.api_id is globally UNIQUE. Every API-Football id is
 * offset by AF_ID_OFFSET (9e9) — far from fdorg ids and well within
 * Number.MAX_SAFE_INTEGER / SQLite INTEGER.
 */

import { ApiFootballError, ApiFootballRestrictedError, QuotaExceededError } from "../types";
import type { IngestedMatch } from "../types";

const BASE_URL = "https://v3.football.api-sports.io";

/** Added to every API-Football match/team id (see header comment). */
export const AF_ID_OFFSET = 9_000_000_000;
export function afNamespacedId(id: number): number {
  return AF_ID_OFFSET + id;
}

/** UTC-date key for the daily call counter in meta. */
export function afCallsUtcKey(date: Date): string {
  return `af_calls_${date.toISOString().slice(0, 10)}`;
}

/** Calendar-year seasons for Nordic leagues: [current, previous, ...]. */
export function apiFootballSeasons(count: number, now = new Date()): number[] {
  const year = now.getUTCFullYear();
  return Array.from({ length: Math.max(1, count) }, (_, k) => year - k);
}

/** "Regular Season - 14" -> 14 (null when no trailing integer). */
export function parseAfMatchday(round: string | undefined): number | null {
  if (!round) return null;
  const m = /(\d+)\s*$/.exec(round);
  return m ? Number(m[1]) : null;
}

const STATUS_MAP: Record<string, string> = {
  FT: "FINISHED",
  AET: "FINISHED",
  PEN: "FINISHED",
  NS: "SCHEDULED",
  TBD: "TIMED",
  "1H": "IN_PLAY",
  "2H": "IN_PLAY",
  ET: "IN_PLAY",
  P: "IN_PLAY",
  LIVE: "IN_PLAY",
  BT: "IN_PLAY",
  HT: "PAUSED",
};

interface AfTeamRef {
  id?: number;
  name?: string;
}

interface AfFixtureEntry {
  fixture?: {
    id?: number;
    date?: string;
    status?: { short?: string };
  };
  league?: { season?: number; round?: string };
  teams?: { home?: AfTeamRef; away?: AfTeamRef };
  goals?: { home?: number | null; away?: number | null };
}

interface AfFixturesResponse {
  paging?: { current?: number; total?: number };
  response?: AfFixtureEntry[];
  /** API-Football returns soft errors (bad league/season/plan) here, often with results: 0. */
  errors?: unknown;
  results?: number;
}

/** Map one API-Football fixture entry to our domain; null = skip (postponed/cancelled/etc). */
export function mapAfFixture(entry: AfFixtureEntry): IngestedMatch | null {
  const status = STATUS_MAP[entry.fixture?.status?.short ?? ""];
  const id = entry.fixture?.id;
  const homeId = entry.teams?.home?.id;
  const awayId = entry.teams?.away?.id;
  const date = entry.fixture?.date;
  if (!status || typeof id !== "number" || typeof homeId !== "number" || typeof awayId !== "number" || !date) {
    return null;
  }
  const finished = status === "FINISHED";
  return {
    apiId: afNamespacedId(id),
    season: entry.league?.season !== undefined ? String(entry.league.season) : "",
    utcDate: date,
    matchday: parseAfMatchday(entry.league?.round),
    status,
    homeApiId: afNamespacedId(homeId),
    homeName: entry.teams?.home?.name ?? `#${homeId}`,
    homeShortName: null,
    awayApiId: afNamespacedId(awayId),
    awayName: entry.teams?.away?.name ?? `#${awayId}`,
    awayShortName: null,
    homeGoals: finished ? (entry.goals?.home ?? null) : null,
    awayGoals: finished ? (entry.goals?.away ?? null) : null,
  };
}

/** Pluggable daily-quota store (D1 meta in prod, in-memory in tests). */
export interface AfQuotaStore {
  get(): Promise<number>;
  incr(): Promise<number>;
}

export const AF_QUOTA_WARN = 80;
export const AF_QUOTA_STOP = 95;

export class ApiFootballClient {
  /** True once today's counter passes AF_QUOTA_WARN (80). */
  quotaWarning = false;
  /** Diagnostics from the most recent call (soft errors + result count). */
  lastDiag: { errors?: unknown; results?: number } | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly quota: AfQuotaStore,
    private readonly minIntervalMs = 1000,
  ) {}

  private lastCallAt = 0;

  private async throttle(): Promise<void> {
    const wait = this.minIntervalMs - (Date.now() - this.lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  private async get(path: string): Promise<AfFixturesResponse> {
    const used = await this.quota.get();
    if (used >= AF_QUOTA_STOP) {
      throw new QuotaExceededError(
        `API-Football daily quota guard: ${used} calls used today (stop at ${AF_QUOTA_STOP} of 100 free-tier) — sync resumes tomorrow UTC`,
      );
    }
    await this.throttle();
    const res = await fetch(`${BASE_URL}${path}`, { headers: { "x-apisports-key": this.apiKey, Accept: "application/json" } });
    const after = await this.quota.incr();
    if (after >= AF_QUOTA_WARN) this.quotaWarning = true;
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new ApiFootballRestrictedError(`API-Football rejected the API_FOOTBALL_KEY (${res.status})`, res.status);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ApiFootballError(`API-Football responded ${res.status} for ${path}`, res.status);
    }
    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) {
      throw new ApiFootballError(`API-Football returned a non-object payload for ${path}`, 200);
    }
    const parsed = data as AfFixturesResponse;
    this.lastDiag = { errors: parsed.errors, results: parsed.results };
    return parsed;
  }

  /**
   * GET /fixtures?league={id}&season={yyyy} — all fixtures for one league
   * season, mapped to domain matches. Follows paging when present (rare on
   * the free tier); every page counts against the daily quota guard.
   */
  async getLeagueFixtures(leagueId: number, season: number): Promise<IngestedMatch[]> {
    const out: IngestedMatch[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const data = await this.get(`/fixtures?league=${leagueId}&season=${season}&page=${page}`);
      totalPages = data.paging?.total ?? 1;
      for (const entry of data.response ?? []) {
        const mapped = mapAfFixture(entry);
        if (mapped) out.push(mapped);
      }
      page++;
    } while (page <= totalPages);
    return out;
  }
}
