/**
 * League registry. Key is the internal league code used across the API and D1.
 * fdOrgCode is the football-data.org v4 competition code; oddsSportKey is the
 * the-odds-api v4 sport key (pinned explicitly — title-based resolution once
 * matched "Premier League" to soccer_russia_premier_league). provider picks
 * the match-data source: "fdorg" (all free-tier competitions) or
 * "apifootball" (api-sports.io, for the Nordic summer leagues fdorg's free
 * tier lacks). apiFootballId is API-Football's published league id (their
 * docs/leagues list; dashboard.api-football.com).
 */

export interface LeagueConfig {
  name: string;
  fdOrgCode: string;
  /** the-odds-api sport key. Checked before any cached/derived mapping. */
  oddsSportKey: string;
  provider: "fdorg" | "apifootball";
  /** API-Football league id (provider "apifootball" only). */
  apiFootballId?: number;
}

const FD = "fdorg" as const;
const AF = "apifootball" as const;

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
  // Nordic summer-calendar leagues via API-Football (api-sports.io league ids
  // 113/119/103/244 from their leagues list — football-data.org's free tier
  // does not carry Scandinavia). In season roughly March–November.
  SWE: { name: "Allsvenskan", fdOrgCode: "", oddsSportKey: "soccer_sweden_allsvenskan", provider: AF, apiFootballId: 113 },
  DEN: { name: "Superliga", fdOrgCode: "", oddsSportKey: "soccer_denmark_superliga", provider: AF, apiFootballId: 119 },
  NOR: { name: "Eliteserien", fdOrgCode: "", oddsSportKey: "soccer_norway_eliteserien", provider: AF, apiFootballId: 103 },
  FIN: { name: "Veikkausliiga", fdOrgCode: "", oddsSportKey: "soccer_finland_veikkausliiga", provider: AF, apiFootballId: 244 },
};
