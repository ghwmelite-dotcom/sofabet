/**
 * League registry. Key is the internal league code used across the API and D1;
 * fdOrgCode is the football-data.org v4 competition code; oddsSportKey is the
 * the-odds-api v4 sport key (pinned explicitly — title-based resolution once
 * matched "Premier League" to soccer_russia_premier_league). All defaults are
 * on the football-data.org free tier. Add/remove entries here as needed.
 */

export interface LeagueConfig {
  name: string;
  fdOrgCode: string;
  /** the-odds-api sport key. Checked before any cached/derived mapping. */
  oddsSportKey: string;
}

export const LEAGUES: Record<string, LeagueConfig> = {
  PL: { name: "Premier League", fdOrgCode: "PL", oddsSportKey: "soccer_epl" },
  ELC: { name: "Championship", fdOrgCode: "ELC", oddsSportKey: "soccer_efl_champ" },
  BL1: { name: "Bundesliga", fdOrgCode: "BL1", oddsSportKey: "soccer_germany_bundesliga" },
  SA: { name: "Serie A", fdOrgCode: "SA", oddsSportKey: "soccer_italy_serie_a" },
  PD: { name: "La Liga", fdOrgCode: "PD", oddsSportKey: "soccer_spain_la_liga" },
  FL1: { name: "Ligue 1", fdOrgCode: "FL1", oddsSportKey: "soccer_france_ligue_one" },
  DED: { name: "Eredivisie", fdOrgCode: "DED", oddsSportKey: "soccer_netherlands_eredivisie" },
  PPL: { name: "Primeira Liga", fdOrgCode: "PPL", oddsSportKey: "soccer_portugal_primeira_liga" },
  // Brazilian Série A — on both free tiers and plays Feb–Dec, i.e. it has live
  // fixtures during the European summer break.
  BSA: { name: "Brasileirão Série A", fdOrgCode: "BSA", oddsSportKey: "soccer_brazil_campeonato" },
};
