import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailboxHeader } from "../MailboxHeader";
import { useUiStore } from "@/stores/useUiStore";
import { useLanguageStore } from "@/lib/i18n";

const refetch = vi.fn();
vi.mock("@/hooks/useMessages", () => ({ useMessages: () => ({ refetch, isFetching: false }) }));
vi.mock("@/hooks/useTags", () => ({
  useTags: () => ({ data: { tags: [] } }),
  useTagMessages: () => ({ refetch, isFetching: false }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ activeFolder: "INBOX", activeTagId: null, searchActive: false, unreadOnly: false, folderDrawerOpen: false });
  useLanguageStore.setState({ language: "en", preference: "en", initialized: true });
});
afterEach(cleanup);

describe("mailbox header", () => {
  it("switches filters and clears the previous message selection", () => {
    useUiStore.setState({ selectedMessageUid: 42, selectedMessageUids: [42], bulkSelectMode: true });
    render(<MailboxHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Unread" }));
    expect(useUiStore.getState()).toMatchObject({ unreadOnly: true, selectedMessageUid: null, selectedMessageUids: [], bulkSelectMode: false });
    expect(screen.getByRole("button", { name: "Unread" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(useUiStore.getState().unreadOnly).toBe(false);
  });

  it("opens folder navigation and refreshes the current mailbox", () => {
    render(<MailboxHeader />);
    fireEvent.click(screen.getByRole("button", { name: "Open folders" }));
    expect(useUiStore.getState().folderDrawerOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh messages" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("translates the header and controls into French", () => {
    useLanguageStore.setState({ language: "fr" });
    render(<MailboxHeader />);
    expect(screen.getByRole("heading", { name: "Boîte de réception" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ouvrir les dossiers" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tous" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Non lu" })).toBeTruthy();
  });
});
