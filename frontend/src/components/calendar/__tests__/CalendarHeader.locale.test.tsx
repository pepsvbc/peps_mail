import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLanguageStore } from "@/lib/i18n";
import { useCalendarStore } from "@/stores/useCalendarStore";
import { CalendarHeader } from "../CalendarHeader";

beforeEach(() => {
  useLanguageStore.setState({ language: "en", preference: "system", initialized: false, hasStoredPreference: false });
  useCalendarStore.setState({ selectedDate: new Date(2026, 9, 13, 9), viewMode: "month" });
});

afterEach(() => {
  useLanguageStore.setState({ language: "en", preference: "system", initialized: false, hasStoredPreference: false });
  localStorage.removeItem("oxi-language");
});

describe("CalendarHeader language switching", () => {
  it("updates labels and date headers without changing calendar wire values", () => {
    render(<CalendarHeader />);
    expect(screen.getByRole("heading", { name: "Calendar" })).toBeTruthy();
    expect(screen.getByText("October 2026")).toBeTruthy();

    act(() => useLanguageStore.getState().setLanguage("fr"));

    expect(screen.getByRole("heading", { name: "Calendrier" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Aujourd’hui" })).toBeTruthy();
    expect(screen.getByText("octobre 2026")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Jour" }));
    expect(useCalendarStore.getState().viewMode).toBe("day");
    expect(screen.getByText("mardi, 13 octobre 2026")).toBeTruthy();
  });
});
