import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AF_ID_OFFSET,
  ApiFootballClient,
  afCallsUtcKey,
  afNamespacedId,
  apiFootballSeasons,
  mapAfFixture,
  parseAfMatchday,
} from "../src/data/apiFootball";
import { QuotaExceededError } from "../src/types";
import { statsEligibleLeagues } from "../src/data/syncStats";
import sample from "./fixtures/apiFootball.sample.json";

const [ftEntry, nsEntry, liveEntry] = sample.response;

describe("mapAfFixture (recorded sample)", () => {
  it("maps a finished fixture with namespaced ids, goals and matchday", () => {
    const m = mapAfFixture(ftEntry);
    expect(m).not.toBeNull();
    expect(m?.apiId).toBe(AF_ID_OFFSET + 1208331);
    expect(m?.homeApiId).toBe(AF_ID_OFFSET + 956);
    expect(m?.awayApiId).toBe(AF_ID_OFFSET + 454);
    expect(m?.status).toBe("FINISHED");
    expect(m?.homeGoals).toBe(3);
    expect(m?.awayGoals).toBe(1);
    expect(m?.matchday).toBe(14);
    expect(m?.season).toBe("2026");
    expect(m?.utcDate).toBe("2026-07-19T17:00:00+00:00");
    expect(m?.homeName).toBe("Hammarby FF");
  });

  it("maps a not-started fixture to SCHEDULED with null goals", () => {
    const m = mapAfFixture(nsEntry);
    expect(m?.status).toBe("SCHEDULED");
    expect(m?.homeGoals).toBeNull();
    expect(m?.awayGoals).toBeNull();
    expect(m?.matchday).toBe(15);
  });

  it("maps an in-play fixture to IN_PLAY with null goals (not gradeable yet)", () => {
    const m = mapAfFixture(liveEntry);
    expect(m?.status).toBe("IN_PLAY");
    expect(m?.homeGoals).toBeNull();
  });

  it("skips postponed/cancelled fixtures", () => {
    expect(mapAfFixture({ fixture: { id: 1, date: "2026-01-01T00:00:00+00:00", status: { short: "PST" } }, teams: { home: { id: 1, name: "A" }, away: { id: 2, name: "B" } }, league: { season: 2026, round: "x" } })).toBeNull();
    expect(mapAfFixture({ fixture: { id: 1, date: "2026-01-01T00:00:00+00:00", status: { short: "CANC" } }, teams: { home: { id: 1, name: "A" }, away: { id: 2, name: "B" } }, league: { season: 2026 } })).toBeNull();
  });

  it("parses matchday from round strings", () => {
    expect(parseAfMatchday("Regular Season - 14")).toBe(14);
    expect(parseAfMatchday("Relegation Round - 3")).toBe(3);
    expect(parseAfMatchday("Cup Final")).toBeNull();
    expect(parseAfMatchday(undefined)).toBeNull();
  });
});

describe("id namespacing", () => {
  it("offsets ids far beyond football-data.org's space, within safe integers", () => {
    expect(afNamespacedId(363)).toBe(9_000_000_363);
    expect(afNamespacedId(1)).toBeGreaterThan(9_000_000_000);
    expect(Number.isSafeInteger(afNamespacedId(999_999_999))).toBe(true);
    // fdorg ids are small integers (< ~1e8); namespaced ids can never collide.
    expect(afNamespacedId(1)).toBeGreaterThan(100_000_000);
  });
});

describe("quota store keys + season list", () => {
  it("daily counter key rolls over by UTC date", () => {
    expect(afCallsUtcKey(new Date("2026-07-23T12:00:00Z"))).toBe("af_calls_2026-07-23");
    expect(afCallsUtcKey(new Date("2026-07-24T00:30:00Z"))).toBe("af_calls_2026-07-24");
  });

  it("calendar-year seasons: current + previous", () => {
    expect(apiFootballSeasons(3, new Date("2026-07-23T00:00:00Z"))).toEqual([2026, 2025, 2024]);
    expect(apiFootballSeasons(1, new Date("2026-01-01T00:00:00Z"))).toEqual([2026]);
  });
});

function memQuota(start = 0) {
  let n = start;
  return { get: async () => n, incr: async () => ++n, count: () => n };
}

describe("ApiFootballClient quota guard (stubbed fetch, no live calls)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches + maps all sample fixtures and increments the counter", async () => {
    const fetchMock = vi.fn(async (_url: unknown) => new Response(JSON.stringify(sample), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const quota = memQuota(0);
    const client = new ApiFootballClient("test-key", quota, 0);
    const fixtures = await client.getLeagueFixtures(113, 2026);
    expect(fixtures.length).toBe(3);
    expect(quota.count()).toBe(1);
    expect(client.quotaWarning).toBe(false);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain("v3.football.api-sports.io/fixtures?league=113&season=2026");
  });

  it("sets quotaWarning at >= 80 calls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(sample), { status: 200 })));
    const quota = memQuota(79);
    const client = new ApiFootballClient("test-key", quota, 0);
    await client.getLeagueFixtures(113, 2026);
    expect(quota.count()).toBe(80);
    expect(client.quotaWarning).toBe(true);
  });

  it("throws QuotaExceededError at >= 95 and never calls fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const quota = memQuota(95);
    const client = new ApiFootballClient("test-key", quota, 0);
    await expect(client.getLeagueFixtures(113, 2026)).rejects.toThrow(QuotaExceededError);
    await expect(client.getLeagueFixtures(113, 2026)).rejects.toThrow(/quota guard/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps 401 to a restricted error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 })),
    );
    const client = new ApiFootballClient("bad-key", memQuota(0), 0);
    await expect(client.getLeagueFixtures(113, 2026)).rejects.toThrow(/rejected/);
  });
});

describe("stats pipeline provider exclusion", () => {
  it("non-fdorg leagues are skipped, fdorg + ad-hoc leagues stay", () => {
    const { eligible, skipped } = statsEligibleLeagues(["PL", "BSA", "SWE", "NOR", "FIN", "ARG", "TEST"]);
    expect(skipped.sort()).toEqual(["ARG", "FIN", "NOR", "SWE"]); // fduk leagues
    expect(eligible).toEqual(["PL", "BSA", "TEST"]);
  });
});
