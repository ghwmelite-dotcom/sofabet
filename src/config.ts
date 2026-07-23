/**
 * League registry. Key is the internal league code used across the API and D1.
 * fdOrgCode is the football-data.org v4 competition code; oddsSportKey is the
 * the-odds-api v4 sport key (pinned explicitly — title-based resolution once
 * matched "Premier League" to soccer_russia_premier_league). provider picks
 * the match-data source:
 * - "fdorg"       — football-data.org (free-tier competitions + bookings)
 * - "fduk"        — football-data.co.uk CSV files (no key needed)
 * - "apifootball" — api-sports.io (kept for a possible paid tier; its free
 *                   plan only serves seasons 2022–2024, so nothing uses it).
 * tier drives the daily odds cadence: majors get h2h odds every day, minors
 * rotate 4/day (3-day cycle). Registry order = display order (majors first).
 *
 * Removed leagues (ELC, DED, PPL, DEN): their D1 data stays frozen and
 * readable; restoring any of them is a one-line re-add here. RUS (Russia)
 * was deliberately left out of the fduk additions: its odds coverage is
 * doubtful post-2022 and the minor rotation is sized for exactly 12.
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
  tier: "major" | "minor";
}

const FD = "fdorg" as const;
const UK = "fduk" as const;
const MAJOR = "major" as const;
const MINOR = "minor" as const;

export const LEAGUES: Record<string, LeagueConfig> = {
  // ---- majors: daily odds sync ----
  PL: { name: "Premier League", fdOrgCode: "PL", oddsSportKey: "soccer_epl", provider: FD, tier: MAJOR },
  PD: { name: "La Liga", fdOrgCode: "PD", oddsSportKey: "soccer_spain_la_liga", provider: FD, tier: MAJOR },
  SA: { name: "Serie A", fdOrgCode: "SA", oddsSportKey: "soccer_italy_serie_a", provider: FD, tier: MAJOR },
  BL1: { name: "Bundesliga", fdOrgCode: "BL1", oddsSportKey: "soccer_germany_bundesliga", provider: FD, tier: MAJOR },
  FL1: { name: "Ligue 1", fdOrgCode: "FL1", oddsSportKey: "soccer_france_ligue_one", provider: FD, tier: MAJOR },
  BSA: { name: "Brasileirão Série A", fdOrgCode: "BSA", oddsSportKey: "soccer_brazil_campeonato", provider: FD, tier: MAJOR },
  // ---- minors: 4/day rotation (fduk CSVs; file existence verified) ----
  SWE: { name: "Allsvenskan", fdOrgCode: "", oddsSportKey: "soccer_sweden_allsvenskan", provider: UK, fdukCode: "SWE", tier: MINOR },
  NOR: { name: "Eliteserien", fdOrgCode: "", oddsSportKey: "soccer_norway_eliteserien", provider: UK, fdukCode: "NOR", tier: MINOR },
  FIN: { name: "Veikkausliiga", fdOrgCode: "", oddsSportKey: "soccer_finland_veikkausliiga", provider: UK, fdukCode: "FIN", tier: MINOR },
  ARG: { name: "Liga Profesional", fdOrgCode: "", oddsSportKey: "soccer_argentina_primera_division", provider: UK, fdukCode: "ARG", tier: MINOR },
  IRL: { name: "Premier Division", fdOrgCode: "", oddsSportKey: "soccer_league_of_ireland", provider: UK, fdukCode: "IRL", tier: MINOR },
  AUT: { name: "Bundesliga (Austria)", fdOrgCode: "", oddsSportKey: "soccer_austria_bundesliga", provider: UK, fdukCode: "AUT", tier: MINOR },
  SUI: { name: "Super League", fdOrgCode: "", oddsSportKey: "soccer_switzerland_superleague", provider: UK, fdukCode: "SWZ", tier: MINOR },
  POL: { name: "Ekstraklasa", fdOrgCode: "", oddsSportKey: "soccer_poland_ekstraklasa", provider: UK, fdukCode: "POL", tier: MINOR },
  // ROU's key is unknown — unpinned so sportKeyFor falls back to live /sports title resolution.
  ROU: { name: "Superliga (Romania)", fdOrgCode: "", oddsSportKey: "", provider: UK, fdukCode: "ROU", tier: MINOR },
  JPN: { name: "J1 League", fdOrgCode: "", oddsSportKey: "soccer_japan_j_league", provider: UK, fdukCode: "JPN", tier: MINOR },
  MEX: { name: "Liga MX", fdOrgCode: "", oddsSportKey: "soccer_mexico_ligamx", provider: UK, fdukCode: "MEX", tier: MINOR },
  MLS: { name: "MLS", fdOrgCode: "", oddsSportKey: "soccer_usa_mls", provider: UK, fdukCode: "USA", tier: MINOR },
};
