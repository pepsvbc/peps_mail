import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUiState } = vi.hoisted(() => ({
  mockUiState: {
    searchQuery: "",
    searchActive: false,
    searchResultCount: null as number | null,
    setSearchQuery: vi.fn(),
    setSearchActive: vi.fn(),
    clearSearch: vi.fn(),
  },
}));

vi.mock("@/stores/useUiStore", () => ({
  useUiStore: (selector: (state: typeof mockUiState) => unknown) => selector(mockUiState),
}));

import { SearchBar } from "../SearchBar";
import { useLanguageStore } from "@/lib/i18n";

describe("SearchBar", () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: "en" });
    vi.useFakeTimers();
    mockUiState.searchQuery = "";
    mockUiState.searchActive = false;
    mockUiState.setSearchQuery.mockReset();
    mockUiState.setSearchActive.mockReset();
    mockUiState.clearSearch.mockReset();
    mockUiState.searchResultCount = null;
  });

  afterEach(() => {
    act(() => useLanguageStore.setState({ language: "en" }));
    vi.useRealTimers();
  });

  it("renders with empty input initially", () => {
    render(<SearchBar />);

    expect(
      (screen.getByPlaceholderText("Search mail... (Ctrl+K)") as HTMLInputElement).value,
    ).toBe("");
    expect(mockUiState.setSearchQuery).not.toHaveBeenCalled();
    expect(mockUiState.setSearchActive).not.toHaveBeenCalled();
    expect(mockUiState.clearSearch).not.toHaveBeenCalled();
  });

  it("commits a valid query after 300ms debounce", () => {
    render(<SearchBar />);

    const input = screen.getByPlaceholderText("Search mail... (Ctrl+K)") as HTMLInputElement;

    fireEvent.change(input, {
      target: { value: "ab" },
    });

    expect(input.value).toBe("ab");
    expect(mockUiState.setSearchQuery).not.toHaveBeenCalled();
    expect(mockUiState.setSearchActive).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(input.value).toBe("ab");
    expect(mockUiState.setSearchQuery).toHaveBeenCalledWith("ab");
    expect(mockUiState.setSearchActive).toHaveBeenCalledWith(true);
    expect(mockUiState.clearSearch).not.toHaveBeenCalled();
  });

  it("clears committed search immediately when input is emptied", () => {
    render(<SearchBar />);

    const input = screen.getByPlaceholderText("Search mail... (Ctrl+K)");

    fireEvent.change(input, { target: { value: "ab" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(mockUiState.setSearchQuery).toHaveBeenCalledWith("ab");
    expect(mockUiState.setSearchActive).toHaveBeenCalledWith(true);

    mockUiState.setSearchQuery.mockClear();
    mockUiState.setSearchActive.mockClear();

    fireEvent.change(input, { target: { value: "   " } });

    expect(mockUiState.clearSearch).toHaveBeenCalledTimes(1);
    expect(mockUiState.setSearchQuery).not.toHaveBeenCalled();
    expect(mockUiState.setSearchActive).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(mockUiState.setSearchQuery).not.toHaveBeenCalled();
    expect(mockUiState.setSearchActive).not.toHaveBeenCalled();
  });

  it("does not reactivate after clear during debounce", () => {
    render(<SearchBar />);

    const input = screen.getByPlaceholderText("Search mail... (Ctrl+K)") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "valid" } });
    expect(input.value).toBe("valid");

    // Clear it before 300ms
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.click(screen.getByLabelText("Clear search"));

    expect(input.value).toBe("");
    expect(mockUiState.clearSearch).toHaveBeenCalled();

    // Advance the remaining time
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Should NOT have committed "valid"
    expect(mockUiState.setSearchQuery).not.toHaveBeenCalledWith("valid");
    expect(mockUiState.setSearchActive).not.toHaveBeenCalledWith(true);
  });

  it("clears when the last filter chip is removed", () => {
    // Initial state with a filter
    mockUiState.searchQuery = "from:alice@example.com";
    render(<SearchBar />);

    const input = screen.getByPlaceholderText("Search mail... (Ctrl+K)") as HTMLInputElement;
    expect(input.value).toBe("from:alice@example.com");

    const removeBtn = screen.getByLabelText("Remove from filter");
    fireEvent.click(removeBtn);

    expect(input.value).toBe("");
    expect(mockUiState.clearSearch).toHaveBeenCalled();
  });

  it("cancels debounce on Escape", () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText("Search mail... (Ctrl+K)") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "valid" } });
    fireEvent.keyDown(input, { key: "Escape" });

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(mockUiState.setSearchQuery).not.toHaveBeenCalled();
  });

  it("cancels debounce on blur", () => {
    render(<SearchBar />);
    const input = screen.getByPlaceholderText("Search mail... (Ctrl+K)") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "valid" } });
    fireEvent.blur(input);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(mockUiState.setSearchQuery).not.toHaveBeenCalled();
  });

  it("switches labels and plural counts live while preserving search operators", () => {
    mockUiState.searchQuery = "from:alice@example.com";
    mockUiState.searchActive = true;
    mockUiState.searchResultCount = 1;
    const { rerender } = render(<SearchBar />);

    expect(screen.getByText("1 result")).toBeTruthy();
    act(() => useLanguageStore.setState({ language: "fr" }));
    const input = screen.getByPlaceholderText("Rechercher un message… (Ctrl+K)") as HTMLInputElement;
    expect(input.value).toBe("from:alice@example.com");
    expect(screen.getByText("1 résultat")).toBeTruthy();
    expect(screen.getByLabelText("Retirer le filtre from")).toBeTruthy();

    mockUiState.searchResultCount = 2;
    rerender(<SearchBar />);
    expect(screen.getByText("2 résultats")).toBeTruthy();

    fireEvent.keyDown(screen.getByLabelText("Aide à la recherche"), { key: "Enter" });
    expect(screen.getByText("Filtrer par expéditeur")).toBeTruthy();
    expect(screen.getByText("from:")).toBeTruthy();
  });

});
