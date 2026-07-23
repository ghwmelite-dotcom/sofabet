/**
 * football-data.co.uk CSV provider (no key, updated ~twice weekly).
 * League files: https://www.football-data.co.uk/new/{CODE}.csv — all seasons
 * of results with closing odds columns (odds earmarked for a future
 * "backtest vs real prices" feature; not ingested today). Upcoming fixtures:
 * https://www.football-data.co.uk/fixtures.csv.
 *
 * The CSVs carry no ids, so we mint deterministic synthetic ids from a 32-bit
 * FNV-1a hash in the 8e9 namespace (fdorg ids are < ~1e8; API-Football's are
 * 9e9-offset). Collision reasoning: teams are league-scoped (~50 per league)
 * and matches ~400 per league-year, so the birthday-bound risk inside a
 * 4.3e9 space is ~1e-5 per league-year — negligible. CRITICAL: the same
 * input must always yield the same id — the results-file sync and the
 * fixtures.csv sync hash `${league}|${utcDate}|${homeNorm}|${awayNorm}`
 * identically, so a fixture's row is later updated (not duplicated) when its
 * result arrives.
 */

import { normalizeTeamName } from "../model/odds";
import { FdukError } from "../types";
import type { IngestedMatch } from "../types";

const LEAGUE_FILE_BASE = "https://www.football-data.co.uk/new";
const FIXTURES_URL = "https://www.football-data.co.uk/fixtures.csv";

export const FDUK_ID_OFFSET = 8_000_000_000;

/** FNV-1a 32-bit, returned as unsigned. */
export function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function fdukTeamApiId(name: string): number {
  return FDUK_ID_OFFSET + hash32(normalizeTeamName(name));
}

export function fdukMatchApiId(league: string, utcDate: string, homeName: string, awayName: string): number {
  return FDUK_ID_OFFSET + hash32(`${league}|${utcDate}|${normalizeTeamName(homeName)}|${normalizeTeamName(awayName)}`);
}

/** Minimal CSV parser: quoted fields, "" escapes, CRLF/LF, BOM, blank lines. */
export function parseCsv(input: string): string[][] {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const pushRow = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      pushRow();
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/** "31/03/2012" (DD/MM/YYYY) -> "2012-03-31"; null when not that shape. */
function parseDmy(date: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Their dates/times are local to the venue; we store them as UTC (kickoff
 * precision is irrelevant to the model). Falls back to 15:00 like our seed
 * convention when the Time column is missing/unparseable. */
function toUtcDate(date: string, time: string | undefined): string | null {
  const d = parseDmy(date);
  if (!d) return null;
  const t = time && /^\d{2}:\d{2}$/.test(time.trim()) ? time.trim() : "15:00";
  return `${d}T${t}:00Z`;
}

function colIndex(header: string[], name: string): number {
  return header.indexOf(name);
}

/** Season label style: "single" (2026) or "slash" (2025/2026, winter leagues). */
export type SeasonStyle = "single" | "slash";

export function detectSeasonStyle(seasonLabels: string[]): SeasonStyle {
  return seasonLabels.some((s) => s.includes("/")) ? "slash" : "single";
}

export function seasonLabelForDate(utcDate: string, style: SeasonStyle): string {
  const year = Number(utcDate.slice(0, 4));
  const month = Number(utcDate.slice(5, 7));
  if (style === "single") return String(year);
  return month >= 7 ? `${year}/${year + 1}` : `${year - 1}/${year}`;
}

export interface LeagueIngest {
  matches: IngestedMatch[];
  seasons: string[];
  style: SeasonStyle;
}

/**
 * League-file rows -> finished matches for the `seasonCount` most recent
 * seasons present in the file (recency derived from the Season column —
 * single-year and slash labels both handled; unplayed rows have no result
 * and are skipped).
 */
export function leagueRowsToIngest(rows: string[][], leagueKey: string, seasonCount: number): LeagueIngest {
  if (rows.length < 2) return { matches: [], seasons: [], style: "single" };
  const header = rows[0];
  const c = {
    season: colIndex(header, "Season"),
    date: colIndex(header, "Date"),
    time: colIndex(header, "Time"),
    home: colIndex(header, "Home"),
    away: colIndex(header, "Away"),
    hg: colIndex(header, "HG"),
    ag: colIndex(header, "AG"),
    res: colIndex(header, "Res"),
  };
  if ([c.season, c.date, c.home, c.away, c.hg, c.ag, c.res].some((i) => i < 0)) {
    throw new FdukError(`football-data.co.uk league CSV for ${leagueKey} has unexpected header: ${header.join(",")}`, 200);
  }
  const startYear = (s: string) => {
    const y = Number(s.slice(0, 4));
    return Number.isFinite(y) ? y : 0;
  };
  const seasons = [...new Set(rows.slice(1).map((r) => r[c.season]))].sort((a, b) => {
    const dy = startYear(b) - startYear(a);
    return dy !== 0 ? dy : b.localeCompare(a);
  });
  const keep = new Set(seasons.slice(0, Math.max(1, seasonCount)));
  const out: IngestedMatch[] = [];
  for (const r of rows.slice(1)) {
    if (!keep.has(r[c.season])) continue;
    const res = (r[c.res] ?? "").trim();
    if (res !== "H" && res !== "D" && res !== "A") continue; // unplayed
    const hg = Number(r[c.hg]);
    const ag = Number(r[c.ag]);
    if (!Number.isInteger(hg) || !Number.isInteger(ag)) continue;
    const utcDate = toUtcDate(r[c.date], c.time >= 0 ? r[c.time] : undefined);
    if (!utcDate) continue;
    const home = r[c.home].trim();
    const away = r[c.away].trim();
    if (!home || !away) continue;
    out.push({
      apiId: fdukMatchApiId(leagueKey, utcDate, home, away),
      season: r[c.season],
      utcDate,
      matchday: null,
      status: "FINISHED",
      homeApiId: fdukTeamApiId(home),
      homeName: home,
      homeShortName: null,
      awayApiId: fdukTeamApiId(away),
      awayName: away,
      awayShortName: null,
      homeGoals: hg,
      awayGoals: ag,
    });
  }
  return { matches: out, seasons, style: detectSeasonStyle(seasons) };
}

/**
 * fixtures.csv rows -> SCHEDULED matches for the leagues in `codeToLeague`
 * (fduk file code -> our league key). Season labels follow each league's own
 * style (single-year vs slash). Same hash inputs as the results file, so the
 * later results sync UPDATES these rows instead of duplicating them.
 */
export function fixturesRowsToIngest(
  rows: string[][],
  codeToLeague: Map<string, string>,
  seasonStyle: Map<string, SeasonStyle>,
): IngestedMatch[] {
  if (rows.length < 2) return [];
  const header = rows[0];
  const c = {
    div: colIndex(header, "Div"),
    date: colIndex(header, "Date"),
    time: colIndex(header, "Time"),
    home: colIndex(header, "HomeTeam"),
    away: colIndex(header, "AwayTeam"),
  };
  if ([c.div, c.date, c.home, c.away].some((i) => i < 0)) {
    throw new FdukError(`football-data.co.uk fixtures CSV has unexpected header: ${header.join(",")}`, 200);
  }
  const out: IngestedMatch[] = [];
  for (const r of rows.slice(1)) {
    const leagueKey = codeToLeague.get(r[c.div]);
    if (!leagueKey) continue;
    const utcDate = toUtcDate(r[c.date], c.time >= 0 ? r[c.time] : undefined);
    if (!utcDate) continue;
    const home = r[c.home].trim();
    const away = r[c.away].trim();
    if (!home || !away) continue;
    out.push({
      apiId: fdukMatchApiId(leagueKey, utcDate, home, away),
      season: seasonLabelForDate(utcDate, seasonStyle.get(leagueKey) ?? "single"),
      utcDate,
      matchday: null,
      status: "SCHEDULED",
      homeApiId: fdukTeamApiId(home),
      homeName: home,
      homeShortName: null,
      awayApiId: fdukTeamApiId(away),
      awayName: away,
      awayShortName: null,
      homeGoals: null,
      awayGoals: null,
    });
  }
  return out;
}

/** Fetch a text file (~1MB league CSVs are bounded; safe to buffer). */
export async function fetchFdukText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    await res.body?.cancel();
    throw new FdukError(`football-data.co.uk responded ${res.status} for ${url}`, res.status);
  }
  return res.text();
}

export function fdukLeagueFileUrl(code: string): string {
  return `${LEAGUE_FILE_BASE}/${encodeURIComponent(code)}.csv`;
}

export function fdukFixturesUrl(): string {
  return FIXTURES_URL;
}
