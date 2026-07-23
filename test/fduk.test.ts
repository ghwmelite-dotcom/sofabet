import { describe, expect, it } from "vitest";
import {
  FDUK_ID_OFFSET,
  detectSeasonStyle,
  fixturesRowsToIngest,
  fdukMatchApiId,
  fdukTeamApiId,
  hash32,
  leagueRowsToIngest,
  parseCsv,
  seasonLabelForDate,
} from "../src/data/fduk";

const LEAGUE_CSV = [
  "Country,League,Season,Date,Time,Home,Away,HG,AG,Res,PSCH,PSCD,PSCA",
  "Sweden,Allsvenskan,2024,30/03/2024,15:00,Elfsborg,Djurgarden,2,1,H,1.9,3.5,3.8",
  "Sweden,Allsvenskan,2025,05/04/2025,16:00,AIK,Malmo FF,0,0,D,2.1,3.3,3.4",
  "Sweden,Allsvenskan,2026,20/07/2026,18:00,Kalmar,Malmo FF,2,2,D,2.4,3.2,2.9",
  "Sweden,Allsvenskan,2026,26/07/2026,15:30,AIK,Hacken,,,,2.0,3.4,3.6", // unplayed
].join("\r\n");

const FIXTURES_CSV = [
  "Div,Date,Time,HomeTeam,AwayTeam,B365H,B365D,B365A",
  "SWE,26/07/2026,15:30,AIK,Hacken,2.0,3.4,3.6",
  "DNK,01/08/2026,18:00,Midtjylland,Brondby,1.8,3.6,4.2",
  "B1,31/05/2026,17:30,Gent,Genk,2.9,3.75,2.2",
].join("\n");

describe("parseCsv", () => {
  it("handles CRLF, BOM, quoted fields and blank lines", () => {
    const rows = parseCsv('﻿a,b,"c, d"\r\n1,2,"x""y"\r\n\r\n3,,z\n');
    expect(rows).toEqual([
      ["a", "b", "c, d"],
      ["1", "2", 'x"y'],
      ["3", "", "z"],
    ]);
  });

  it("parses the real league header shape", () => {
    const rows = parseCsv(LEAGUE_CSV);
    expect(rows.length).toBe(5);
    expect(rows[0][2]).toBe("Season");
  });
});

describe("leagueRowsToIngest", () => {
  it("maps finished rows, skips unplayed, keeps only the N most recent seasons", () => {
    const one = leagueRowsToIngest(parseCsv(LEAGUE_CSV), "SWE", 1);
    expect(one.seasons).toEqual(["2026", "2025", "2024"]);
    expect(one.matches.length).toBe(1); // only 2026, and the unplayed AIK row is skipped
    const m = one.matches[0];
    expect(m.season).toBe("2026");
    expect(m.status).toBe("FINISHED");
    expect(m.utcDate).toBe("2026-07-20T18:00:00Z");
    expect(m.homeGoals).toBe(2);
    expect(m.matchday).toBeNull();

    const three = leagueRowsToIngest(parseCsv(LEAGUE_CSV), "SWE", 3);
    expect(three.matches.length).toBe(3);
    expect(three.style).toBe("single");
  });

  it("handles slash season labels (winter leagues) by leading year", () => {
    const csv = [
      "Country,League,Season,Date,Time,Home,Away,HG,AG,Res",
      "Denmark,Superliga,2024/2025,21/07/2024,18:00,Midtjylland,Brondby,1,0,H",
      "Denmark,Superliga,2025/2026,17/05/2026,17:00,Midtjylland,Brondby,2,3,A",
    ].join("\n");
    const one = leagueRowsToIngest(parseCsv(csv), "DEN", 1);
    expect(one.seasons[0]).toBe("2025/2026");
    expect(one.matches.length).toBe(1);
    expect(one.style).toBe("slash");
    expect(seasonLabelForDate("2026-08-01T18:00:00Z", one.style)).toBe("2026/2027");
    expect(seasonLabelForDate("2026-05-01T18:00:00Z", one.style)).toBe("2025/2026");
    expect(detectSeasonStyle(one.seasons)).toBe("slash");
  });
});

describe("synthetic ids", () => {
  it("are deterministic and namespaced", () => {
    expect(fdukTeamApiId("AIK")).toBe(fdukTeamApiId("AIK"));
    expect(fdukTeamApiId("AIK")).not.toBe(fdukTeamApiId("Hacken"));
    expect(fdukTeamApiId("AIK")).toBeGreaterThanOrEqual(FDUK_ID_OFFSET);
    expect(fdukTeamApiId("AIK")).toBeLessThan(FDUK_ID_OFFSET + 2 ** 32);
    expect(Number.isSafeInteger(fdukMatchApiId("SWE", "2026-07-26T15:30:00Z", "AIK", "Hacken"))).toBe(true);
    expect(hash32("x")).toBeGreaterThanOrEqual(0);
  });

  it("results-file row and fixtures.csv row for the same match get the SAME match id", () => {
    // Same league/date/teams in both sources — the fixture row must be
    // updated (not duplicated) when the result later arrives.
    const leagueSide = leagueRowsToIngest(
      parseCsv(
        "Country,League,Season,Date,Time,Home,Away,HG,AG,Res\n" +
          "Sweden,Allsvenskan,2026,26/07/2026,15:30,AIK,Hacken,2,1,H",
      ),
      "SWE",
      1,
    ).matches[0];
    const fixtureSide = fixturesRowsToIngest(
      parseCsv("Div,Date,Time,HomeTeam,AwayTeam\nSWE,26/07/2026,15:30,AIK,Hacken"),
      new Map([["SWE", "SWE"]]),
      new Map([["SWE", "single"]]),
    )[0];
    expect(fixtureSide.apiId).toBe(leagueSide.apiId);
    expect(fixtureSide.status).toBe("SCHEDULED");
    expect(fixtureSide.homeGoals).toBeNull();
    expect(fixtureSide.homeApiId).toBe(leagueSide.homeApiId);
  });
});

describe("fixturesRowsToIngest", () => {
  it("keeps only mapped league codes and labels seasons by league style", () => {
    const rows = parseCsv(FIXTURES_CSV);
    const out = fixturesRowsToIngest(
      rows,
      new Map([
        ["SWE", "SWE"],
        ["DNK", "DEN"],
      ]),
      new Map([
        ["SWE", "single"],
        ["DEN", "slash"],
      ]),
    );
    expect(out.length).toBe(2); // B1 row dropped
    expect(out[0].season).toBe("2026");
    expect(out[1].season).toBe("2026/2027");
    expect(out.every((m) => m.status === "SCHEDULED" && m.homeGoals === null)).toBe(true);
  });

  it("returns [] for a file with no matching divisions", () => {
    const out = fixturesRowsToIngest(parseCsv("Div,Date,Time,HomeTeam,AwayTeam\nB1,31/05/2026,17:30,Gent,Genk"), new Map([["SWE", "SWE"]]), new Map());
    expect(out).toEqual([]);
  });
});
