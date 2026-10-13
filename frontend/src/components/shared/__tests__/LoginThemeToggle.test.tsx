import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginThemeToggle } from "../LoginThemeToggle";
import { useUiStore } from "@/stores/useUiStore";
import { useLanguageStore } from "@/lib/i18n";

let media: MediaQueryList;
let changeListeners: Set<(event: MediaQueryListEvent) => void>;

function changeSystemTheme(dark: boolean) {
  Object.defineProperty(media, "matches", { value: dark, configurable: true });
  act(() => {
    changeListeners.forEach((listener) => listener({ matches: dark } as MediaQueryListEvent));
  });
}

beforeEach(() => {
  localStorage.clear();
  useLanguageStore.setState({ language: "en", preference: "system", initialized: false, hasStoredPreference: false });
  document.documentElement.classList.remove("dark");
  useUiStore.setState({ theme: "system" });
  changeListeners = new Set();
  media = {
    matches: false,
    addEventListener: vi.fn((_type, listener) => changeListeners.add(listener)),
    removeEventListener: vi.fn((_type, listener) => changeListeners.delete(listener)),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => media));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  useLanguageStore.setState({ language: "en", preference: "system", initialized: false, hasStoredPreference: false });
  document.documentElement.classList.remove("dark");
});

describe("login theme chooser", () => {
  it("migrates the previous theme before signing in", () => {
    localStorage.setItem("oxi-theme", "dark");
    render(<LoginThemeToggle />);
    expect(screen.getByRole("button", { name: "Dark", pressed: true })).toBeTruthy();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("peps-mail-theme")).toBe("dark");
    expect(localStorage.getItem("oxi-theme")).toBeNull();
  });

  it("updates theme labels when the language changes without losing the selected theme", () => {
    localStorage.setItem("peps-mail-theme", "dark");
    render(<LoginThemeToggle />);
    act(() => useLanguageStore.getState().setLanguage("fr"));
    expect(screen.getByRole("group", { name: "Thème de couleur" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sombre", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clair" })).toBeTruthy();
    act(() => useLanguageStore.getState().setLanguage("en"));
    expect(screen.getByRole("button", { name: "Dark", pressed: true })).toBeTruthy();
  });

  it("restores a saved dark preference before signing in", () => {
    localStorage.setItem("peps-mail-theme", "dark");

    render(<LoginThemeToggle />);

    expect(screen.getByRole("group", { name: "Color theme" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dark", pressed: true })).toBeTruthy();
    expect(useUiStore.getState().theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("applies and saves explicit choices immediately", () => {
    render(<LoginThemeToggle />);

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("peps-mail-theme")).toBe("dark");
    expect(useUiStore.getState().theme).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("peps-mail-theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Light", pressed: true })).toBeTruthy();
  });

  it("follows system changes only while System is selected and removes the listener on unmount", () => {
    const { unmount } = render(<LoginThemeToggle />);

    changeSystemTheme(true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    changeSystemTheme(false);
    changeSystemTheme(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("peps-mail-theme")).toBe("system");
    changeSystemTheme(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    unmount();
    expect(changeListeners.size).toBe(0);
  });

  it("uses the system preference when the saved value is invalid", () => {
    localStorage.setItem("peps-mail-theme", "invalid");
    changeSystemTheme(true);

    render(<LoginThemeToggle />);

    expect(screen.getByRole("button", { name: "System", pressed: true })).toBeTruthy();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("still changes theme when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });

    render(<LoginThemeToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByRole("button", { name: "Dark", pressed: true })).toBeTruthy();
  });
});
