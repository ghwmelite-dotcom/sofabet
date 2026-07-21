/**
 * League registry. Key is the internal league code used across the API and D1;
 * fdOrgCode is the football-data.org v4 competition code. All defaults are on
 * the football-data.org free tier. Add/remove entries here as needed.
 */

export interface LeagueConfig {
  name: string;
  fdOrgCode: string;
}

export const LEAGUES: Record<string, LeagueConfig> = {
  PL: { name: "Premier League", fdOrgCode: "PL" },
  ELC: { name: "Championship", fdOrgCode: "ELC" },
  BL1: { name: "Bundesliga", fdOrgCode: "BL1" },
  SA: { name: "Serie A", fdOrgCode: "SA" },
  PD: { name: "La Liga", fdOrgCode: "PD" },
  FL1: { name: "Ligue 1", fdOrgCode: "FL1" },
  DED: { name: "Eredivisie", fdOrgCode: "DED" },
  PPL: { name: "Primeira Liga", fdOrgCode: "PPL" },
};
