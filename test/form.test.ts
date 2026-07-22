import { describe, expect, it } from "vitest";
import { computeTeamForm } from "../src/model/form";
import type { FormMatchRow } from "../src/types";

function row(
  day: number,
  homeId: number,
  awayId: number,
  homeGoals: number,
  awayGoals: number,
): FormMatchRow {
  return {
    utc_date: new Date(Date.UTC(2026, 0, day)).toISOString(),
    home_team_id: homeId,
    away_team_id: awayId,
    home_goals: homeGoals,
    away_goals: awayGoals,
    home_name: `Team ${homeId}`,
    away_name: `Team ${awayId}`,
  };
}

describe("computeTeamForm", () => {
  it("computes W/D/L, opponent and goals from both venues, newest first", () => {
    // Team 1: home win (day 10), away loss (day 8), home draw (day 5).
    const rows = [row(10, 1, 2, 3, 1), row(8, 3, 1, 2, 0), row(5, 1, 4, 2, 2)];
    const form = computeTeamForm(rows, 1);
    expect(form.recent.length).toBe(3);
    expect(form.recent[0]).toMatchObject({
      opponentName: "Team 2",
      homeAway: "home",
      goalsFor: 3,
      goalsAgainst: 1,
      result: "W",
    });
    expect(form.recent[1]).toMatchObject({ homeAway: "away", goalsFor: 0, goalsAgainst: 2, result: "L" });
    expect(form.recent[2]).toMatchObject({ result: "D" });
    expect(form.overall).toEqual({ played: 3, gf: 5, ga: 5 });
    expect(form.home).toEqual({ played: 2, gf: 5, ga: 3 });
    expect(form.away).toEqual({ played: 1, gf: 0, ga: 2 });
  });

  it("caps recent/overall at 5 and venue splits at 5 each", () => {
    // Team 1 plays 14 straight home games (alternating W/L), then away games.
    const rows: FormMatchRow[] = [];
    for (let i = 1; i <= 14; i++) rows.push(row(i, 1, 2, i % 2 === 0 ? 2 : 0, 1));
    for (let i = 15; i <= 20; i++) rows.push(row(i, 2, 1, 1, 3)); // team 1 away wins
    rows.sort((a, b) => b.utc_date.localeCompare(a.utc_date));
    const form = computeTeamForm(rows, 1);
    expect(form.recent.length).toBe(5);
    expect(form.recent.every((g) => g.result === "W" && g.goalsFor === 3)).toBe(true);
    expect(form.overall).toEqual({ played: 5, gf: 15, ga: 5 });
    // Home split: the last 5 HOME games (days 10..14): W at 10,12,14.
    expect(form.home.played).toBe(5);
    expect(form.home.gf).toBe(2 + 0 + 2 + 0 + 2); // days 10,11,12,13,14
    // Away split covers exactly the 5 away games.
    expect(form.away).toEqual({ played: 5, gf: 15, ga: 5 });
  });

  it("handles a team with no matches", () => {
    const form = computeTeamForm([], 99);
    expect(form.recent).toEqual([]);
    expect(form.overall).toEqual({ played: 0, gf: 0, ga: 0 });
    expect(form.home).toEqual({ played: 0, gf: 0, ga: 0 });
    expect(form.away).toEqual({ played: 0, gf: 0, ga: 0 });
  });
});
