import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUiStore } from "@/stores/useUiStore";
import { SearchBar } from "../SearchBar";
import { SearchResults } from "../SearchResults";

vi.mock("@/hooks/useSearch", () => ({
  useSearch: () => ({ data: { total_count: 1, results: [{
    uid: 42, folder: "Archive", subject: "Training schedule", from_address: "coach@example.com",
    from_name: "Coach", date: "2026-10-19T10:00:00Z", flags: [], has_attachments: false, snippet: "Next practice",
  }] }, isLoading: false, isError: false }),
}));
afterEach(cleanup);

it("searches from an open message and opens a result from another folder", () => {
  useUiStore.setState({ activeFolder: "INBOX", selectedMessageUid: 7, searchQuery: "", searchActive: false, effectiveAnimationMode: "off" });
  render(<><SearchBar /><SearchResults /></>);
  const input = screen.getByPlaceholderText("Search mail... (Ctrl+K)");
  fireEvent.change(input, { target: { value: "training" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useUiStore.getState()).toMatchObject({ searchQuery: "training", searchActive: true, selectedMessageUid: null });
  fireEvent.click(screen.getByRole("button", { name: /Training schedule/ }));
  expect(useUiStore.getState()).toMatchObject({ activeFolder: "Archive", selectedMessageUid: 42, searchQuery: "training", searchActive: true });
});
