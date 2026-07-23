import { describe, expect, it } from "vitest";
import { dayOfYearUtc, pickMinorsForDay } from "../src/data/syncOdds";
import { LEAGUES } from "../src/config";

const MINORS = Object.entries(LEAGUES).filter(([, c]) => c.tier === "minor").map(([k]) => k);

describe("minor odds rotation", () => {
  it("registry currently holds 6 majors + 12 minors", () => {
    const majors = Object.entries(LEAGUES).filter(([, c]) => c.tier === "major").map(([k]) => k);
    expect(majors).toEqual(["PL", "PD", "SA", "BL1", "FL1", "BSA"]);
    expect(MINORS.length).toBe(12);
  });

  it("dayOfYearUtc is 1-based and UTC-stable", () => {
    expect(dayOfYearUtc(new Date("2026-01-01T00:00:00Z"))).toBe(1);
    expect(dayOfYearUtc(new Date("2026-12-31T23:59:00Z"))).toBe(365);
    expect(dayOfYearUtc(new Date("2024-12-31T12:00:00Z"))).toBe(366); // leap year
  });

  it("gives exactly 4 minors per day", () => {
    for (let day = 1; day <= 366; day++) {
      const pick = pickMinorsForDay(MINORS, day);
      expect(pick.length).toBe(4);
      expect(new Set(pick).size).toBe(4); // no dup within a day
    }
  });

  it("covers all 12 minors over any 3 consecutive days, deterministically", () => {
    for (const start of [1, 100, 200, 364]) {
      const union = new Set([
        ...pickMinorsForDay(MINORS, start),
        ...pickMinorsForDay(MINORS, start + 1),
        ...pickMinorsForDay(MINORS, start + 2),
      ]);
      expect(union.size).toBe(12);
      expect([...union].sort()).toEqual([...MINORS].sort());
    }
    // Deterministic: same day-of-year always picks the same group.
    expect(pickMinorsForDay(MINORS, 42)).toEqual(pickMinorsForDay(MINORS, 42));
    expect(pickMinorsForDay(MINORS, 42)).toEqual(pickMinorsForDay(MINORS, 42 + 3));
  });
});
