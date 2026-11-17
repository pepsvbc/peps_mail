import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLanguageStore } from "@/lib/i18n";

import { DisplaySettings } from "../DisplaySettings";

const { mockUseDisplayPreferences, mockUseUpdateDisplayPreferences, mockMutate } = vi.hoisted(() => ({
  mockUseDisplayPreferences: vi.fn(),
  mockUseUpdateDisplayPreferences: vi.fn(),
  mockMutate: vi.fn(),
}));

vi.mock("@/hooks/useDisplayPreferences", () => ({
  useDisplayPreferences: mockUseDisplayPreferences,
  useUpdateDisplayPreferences: mockUseUpdateDisplayPreferences,
}));

describe("DisplaySettings animation mode", () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: "en", preference: "system" });
    mockMutate.mockReset();
    mockUseUpdateDisplayPreferences.mockReturnValue({ mutate: mockMutate });
    mockUseDisplayPreferences.mockReturnValue({
      isLoading: false,
      data: {
        density: "comfortable",
        theme: "system",
        language: "en",
        compose_format: "html",
        deep_index: false,
        animation_mode: "subtle",
        updated_at: "2026-03-14T00:00:00Z",
      },
    });
  });

  afterEach(() => {
    useLanguageStore.setState({ language: "en", preference: "system" });
    localStorage.removeItem("peps-mail-language");
  });

  it("saves the Gmail-style reading layout and can restore split view", () => {
    render(<DisplaySettings />);
    fireEvent.click(screen.getByRole("button", { name: "Full message" }));
    expect(mockMutate).toHaveBeenCalledWith({ hide_message_list: true }, expect.any(Object));
    fireEvent.click(screen.getByRole("button", { name: "Split view" }));
    expect(mockMutate).toHaveBeenCalledWith({ hide_message_list: false }, expect.any(Object));
  });

  it("saves Standard density between Compact and Comfortable", () => {
    render(<DisplaySettings />);
    const densityOptions = screen.getAllByRole("button").filter((button) => ["Compact", "Standard", "Comfortable"].includes(button.textContent ?? ""));
    expect(densityOptions.map((button) => button.textContent)).toEqual(["Compact", "Standard", "Comfortable"]);
    fireEvent.click(screen.getByRole("button", { name: "Standard" }));
    expect(mockMutate).toHaveBeenCalledWith({ density: "standard" }, expect.any(Object));
  });

  it("switches language immediately and saves the account preference", () => {
    render(<DisplaySettings />);
    fireEvent.click(screen.getByRole("button", { name: "Français" }));
    expect(screen.getByRole("heading", { name: "Affichage" })).toBeTruthy();
    expect(mockMutate).toHaveBeenCalledWith({ language: "fr" }, expect.objectContaining({ onError: expect.any(Function) }));
    expect(localStorage.getItem("peps-mail-language")).toBe("fr");
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("heading", { name: "Display" })).toBeTruthy();
  });

  it("shows the existing animation mode selected", () => {
    render(<DisplaySettings />);

    const subtleButton = screen.getByRole("button", { name: "Subtle" });
    expect(subtleButton.className).toContain("bg-background");
  });

  it("updates animation_mode when selecting each option", () => {
    render(<DisplaySettings />);

    const options: Array<{ label: string; value: "rich" | "medium" | "subtle" | "off" }> = [
      { label: "Rich", value: "rich" },
      { label: "Medium", value: "medium" },
      { label: "Subtle", value: "subtle" },
      { label: "Off", value: "off" },
    ];

    for (const option of options) {
      fireEvent.click(screen.getByRole("button", { name: option.label }));
      expect(mockMutate).toHaveBeenCalledWith(
        { animation_mode: option.value },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
    }
  });

  it("resets animation_mode to null", () => {
    render(<DisplaySettings />);

    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({ animation_mode: null, density: "standard" }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });
});
