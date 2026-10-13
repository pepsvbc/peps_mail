import { describe, expect, it } from "vitest";
import {
  formatDayHeader,
  formatMonthYear,
  formatTime,
  getDayNames,
} from "../calendarUtils";

describe("calendar locale formatting", () => {
  it("uses Swiss French month and weekday names in the chosen week order", () => {
    const date = new Date(2026, 9, 13, 9, 30);

    expect(formatMonthYear(date, "fr-CH")).toBe("octobre 2026");
    expect(formatDayHeader(date, "fr-CH")).toBe("mardi, 13 octobre 2026");
    expect(getDayNames(1, "fr-CH")).toEqual([
      "lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim.",
    ]);
    expect(getDayNames(0, "en-GB")[0]).toBe("Sun");
  });

  it("retains the selected time format and renders midnight as 00:00 in 24h mode", () => {
    expect(formatTime("2026-10-13T00:00:00", "24h", "fr-CH")).toBe("00:00");
    expect(formatTime("2026-10-13T15:30:00", "24h", "fr-CH")).toBe("15:30");
    expect(formatTime("2026-10-13T15:30:00", "12h", "en-GB")).toMatch(/3:30\s*pm/i);
  });
});
