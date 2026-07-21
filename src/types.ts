/**
 * Domain types shared across data, model, and API layers.
 */

export interface TeamRow {
  id: number;
  league: string;
  api_id: number;
  name: string;
  short_name: string | null;
}

export interface MatchRow {
  id: number;
  league: string;
  api_id: number;
  season: string;
  utc_date: string;
  matchday: number | null;
  status: string;
  home_team_id: number;
  away_team_id: number;
  home_goals: number | null;
  away_goals: number | null;
}

/** Minimal finished-match shape the pure model functions consume. */
export interface ModelMatch {
  homeTeamId: number;
  awayTeamId: number;
  homeGoals: number;
  awayGoals: number;
  /** ISO 8601 date string. */
  utcDate: string;
}

/** A finished match with booked-yellow counts — the cards model's input. */
export interface CardMatch {
  homeTeamId: number;
  awayTeamId: number;
  homeYellow: number;
  awayYellow: number;
  /** ISO 8601 date string. */
  utcDate: string;
}

/** A match as ingested from the upstream API, before D1 id resolution. */
export interface IngestedMatch {
  apiId: number;
  season: string;
  utcDate: string;
  matchday: number | null;
  status: string;
  homeApiId: number;
  homeName: string;
  homeShortName: string | null;
  awayApiId: number;
  awayName: string;
  awayShortName: string | null;
  homeGoals: number | null;
  awayGoals: number | null;
}

/** Bet tracker row. status: 'open' | 'won' | 'lost' | 'void'. */
export interface BetRow {
  id: number;
  created_at: string;
  league: string | null;
  match_id: number | null;
  match_label: string;
  bookmaker: string;
  market: string;
  selection: string;
  line: number | null;
  odds: number;
  stake: number;
  status: string;
  settled_at: string | null;
  profit: number | null;
}

/** HTTP error with a status code, translated to `{error}` JSON by the router. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/** Upstream football-data.org failure (rate limits, auth, server errors). */
export class FootballDataError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "FootballDataError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Match-detail (bookings) endpoint is restricted on the current API tier. */
export class StatsRestrictedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "StatsRestrictedError";
    this.status = status;
  }
}
