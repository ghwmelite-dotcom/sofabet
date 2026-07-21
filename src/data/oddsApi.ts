/**
 * the-odds-api v4 client (https://api.the-odds-api.com/v4). Key comes from
 * the ODDS_API_KEY secret. Usage quota is per-market-request (500/month on
 * the free tier); every response carries x-requests-remaining/used headers,
 * which the caller persists into the meta table.
 */

import { OddsApiError, OddsRestrictedError } from "../types";

const BASE_URL = "https://api.the-odds-api.com/v4";

export interface OddsSport {
  key: string;
  title: string;
  active?: boolean;
}

export interface OddsOutcome {
  name: string;
  price: number;
  point?: number;
}

export interface OddsMarket {
  key: string;
  outcomes?: OddsOutcome[];
}

export interface OddsBookmaker {
  key: string;
  markets?: OddsMarket[];
}

export interface OddsEvent {
  id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers?: OddsBookmaker[];
}

export class OddsApiClient {
  /** Latest quota headers seen; null until the first response. */
  quotaRemaining: number | null = null;
  quotaUsed: number | null = null;

  constructor(private readonly apiKey: string) {}

  private async get(path: string): Promise<unknown> {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${BASE_URL}${path}${sep}apiKey=${encodeURIComponent(this.apiKey)}`, {
      headers: { Accept: "application/json" },
    });
    const remaining = res.headers.get("x-requests-remaining");
    const used = res.headers.get("x-requests-used");
    if (remaining !== null) this.quotaRemaining = Number(remaining);
    if (used !== null) this.quotaUsed = Number(used);
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new OddsRestrictedError(`the-odds-api rejected the ODDS_API_KEY (${res.status})`, res.status);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new OddsApiError(
        `the-odds-api responded ${res.status} for ${path}` +
          (res.status === 429 ? " (quota exceeded — free tier is 500 requests/month)" : ""),
        res.status,
      );
    }
    return res.json();
  }

  /** GET /sports — full sport list ({key, title}). */
  async listSports(): Promise<OddsSport[]> {
    const data = await this.get("/sports");
    if (!Array.isArray(data)) throw new OddsApiError("the-odds-api /sports returned a non-array payload", 200);
    return data.filter(
      (s): s is OddsSport =>
        typeof s === "object" && s !== null && typeof s.key === "string" && typeof s.title === "string",
    );
  }

  /**
   * GET /sports/{sportKey}/odds — events with bookmaker markets.
   * Cost: one quota unit per market requested. markets e.g. "h2h" or
   * "h2h,totals". regions=eu (see README: EU consensus is the sharp
   * reference we compare against).
   */
  async getEventOdds(sportKey: string, markets: string): Promise<OddsEvent[]> {
    const data = await this.get(
      `/sports/${encodeURIComponent(sportKey)}/odds?regions=eu&markets=${encodeURIComponent(markets)}&oddsFormat=decimal&dateFormat=iso`,
    );
    if (!Array.isArray(data)) {
      throw new OddsApiError(`the-odds-api odds payload for ${sportKey} is not an array`, 200);
    }
    return data as OddsEvent[];
  }
}
