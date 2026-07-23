/**
 * League registry. Key is the internal league code used across the API and D1.
 * fdOrgCode is the football-data.org v4 competition code; oddsSportKey is the
 * the-odds-api v4 sport key (pinned explicitly — title-based resolution once
 * matched "Premier League" to soccer_russia_premier_league). provider picks
 * the match-data source:
 * - "fdorg"       — football-data.org (free-tier competitions + bookings)
 * - "fduk"        — football-data.co.uk CSV files (Nordic leagues; no key
 *                   needed). fdukCode is the /new/{CODE}.csv file code.
 * - "apifootball" — api-sports.io (kept for a possible paid tier; its free
 *                   plan only serves seasons 2022–2024, so no league routes
 *                   to it today).
 */

export interface LeagueConfig {
  name: string;
  fdOrgCode: string;
  /** the-odds-api sport key. Checked before any cached/derived mapping. */
  oddsSportKey: string;
  provider: "fdorg" | "apifootball" | "fduk";
  /** football-data.co.uk /new/{fdukCode}.csv file code (provider "fduk"). */
  fdukCode?: string;
  /** API-Football league id (provider "apifootball"; unused while free). */
  apiFootballId?: number;
}

const FD = "fdorg" as const;
const UK = "fduk" as const;

export const LEAGUES: Record<string, LeagueConfig> = {
  PL: { name: "Premier League", fdOrgCode: "PL", oddsSportKey: "soccer_epl", provider: FD },
  ELC: { name: "Championship", fdOrgCode: "ELC", oddsSportKey: "soccer_efl_champ", provider: FD },
  BL1: { name: "Bundesliga", fdOrgCode: "BL1", oddsSportKey: "soccer_germany_bundesliga", provider: FD },
  SA: { name: "Serie A", fdOrgCode: "SA", oddsSportKey: "soccer_italy_serie_a", provider: FD },
  PD: { name: "La Liga", fdOrgCode: "PD", oddsSportKey: "soccer_spain_la_liga", provider: FD },
  FL1: { name: "Ligue 1", fdOrgCode: "FL1", oddsSportKey: "soccer_france_ligue_one", provider: FD },
  DED: { name: "Eredivisie", fdOrgCode: "DED", oddsSportKey: "soccer_netherlands_eredivisie", provider: FD },
  PPL: { name: "Primeira Liga", fdOrgCode: "PPL", oddsSportKey: "soccer_portugal_primeira_liga", provider: FD },
  // Brazilian Série A — on both free tiers and plays Feb–Dec, i.e. it has live
  // fixtures during the European summer break.
  BSA: { name: "Brasileirão Série A", fdOrgCode: "BSA", oddsSportKey: "soccer_brazil_campeonato", provider: FD },
  // Nordic leagues via football-data.co.uk CSVs (free, no key, updated ~twice
  // weekly). SWE/NOR/FIN are single-year summer leagues; DEN is a winter
  // league with split-year season labels (2025/2026).
  SWE: { name: "Allsvenskan", fdOrgCode: "", oddsSportKey: "soccer_sweden_allsvenskan", provider: UK, fdukCode: "SWE" },
  DEN: { name: "Superliga", fdOrgCode: "", oddsSportKey: "soccer_denmark_superliga", provider: UK, fdukCode: "DNK" },
  NOR: { name: "Eliteserien", fdOrgCode: "", oddsSportKey: "soccer_norway_eliteserien", provider: UK, fdukCode: "NOR" },
  FIN: { name: "Veikkausliiga", fdOrgCode: "", oddsSportKey: "soccer_finland_veikkausliiga", provider: UK, fdukCode: "FIN" },
};

