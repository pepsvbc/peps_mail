import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountUnreadCount } from "@/hooks/useAccountUnreadCounts";
import { NavRail } from "../NavRail";
import { useAuthStore } from "@/stores/useAuthStore";
import { useUiStore } from "@/stores/useUiStore";
import { useLanguageStore } from "@/lib/i18n";
import { brand } from "@/lib/brand";

const { counts } = vi.hoisted(() => ({ counts: {} as Record<string, AccountUnreadCount> }));
vi.mock("@/hooks/useAccountUnreadCounts", () => ({ useAccountUnreadCounts: () => counts }));
vi.mock("@/hooks/useDisplayPreferences", () => ({ useUpdateDisplayPreferences: () => ({ mutate: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

beforeEach(() => {
  useAuthStore.setState({
    accounts: ["a1", "a2"].map((id) => ({ id, email: `${id}@example.com`, imapHost: "imap.example.com", smtpHost: "smtp.example.com" })),
    activeAccountId: "a1",
  });
  useUiStore.setState({ theme: "light" });
  useLanguageStore.setState({ language: "en" });
  counts.a1 = { count: 3, isLoading: false, isError: false };
  counts.a2 = { count: 7, isLoading: false, isError: false };
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ accounts: [], activeAccountId: null });
  useLanguageStore.setState({ language: "en" });
});

describe("Mail navigation unread total", () => {
  it("keeps the brand mark separate from Inbox navigation", () => {
    render(<NavRail />);
    expect(screen.queryByRole("button", { name: "Go to inbox" })).toBeNull();
    expect(screen.getByRole("img", { name: brand.appName })).toBeTruthy();
  });

  it("returns to the Inbox when Mail is selected", () => {
    useUiStore.setState({
      viewMode: "contacts",
      activeFolder: "Sent",
      searchActive: true,
      searchQuery: "invoice",
    });
    render(<NavRail />);

    fireEvent.click(screen.getByRole("button", { name: "Mail — 10 unread messages in all inboxes" }));

    expect(useUiStore.getState()).toMatchObject({
      viewMode: "mail",
      activeFolder: "INBOX",
      searchActive: false,
      searchQuery: "",
    });
  });

  it("includes the active Inbox and keeps the same total when switching accounts", () => {
    render(<NavRail />);
    expect(screen.getByRole("button", { name: "Mail — 10 unread messages in all inboxes" }).textContent).toBe("10");
    act(() => useAuthStore.setState({ activeAccountId: "a2" }));
    expect(screen.getByRole("button", { name: "Mail — 10 unread messages in all inboxes" }).textContent).toBe("10");
    act(() => useLanguageStore.setState({ language: "fr" }));
    expect(screen.getByRole("button", { name: "Messagerie — 10 messages non lus dans toutes les boîtes de réception" }).textContent).toBe("10");
  });

  it("shows the active Inbox count when only one account is signed in", () => {
    useAuthStore.setState({ accounts: useAuthStore.getState().accounts.slice(0, 1) });
    render(<NavRail />);
    expect(screen.getByRole("button", { name: "Mail — 3 unread messages in all inboxes" }).textContent).toBe("3");
  });

  it("updates the badge when counts change and hides it when all Inboxes are read", () => {
    const { rerender } = render(<NavRail />);
    counts.a1.count = 0;
    counts.a2.count = 1;
    rerender(<NavRail />);
    expect(screen.getByRole("button", { name: "Mail — 1 unread message in all inboxes" }).textContent).toBe("1");
    counts.a2.count = 0;
    rerender(<NavRail />);
    expect(screen.getByRole("button", { name: "Mail" }).textContent).toBe("");
  });

  it("marks a partial total when an account count is unavailable", () => {
    counts.a2 = { count: undefined, isLoading: false, isError: true };
    render(<NavRail />);
    expect(screen.getByRole("button", { name: "Mail — at least 3 unread messages in all inboxes" }).textContent).toBe("3+");
  });

  it("caps the visible total at 99+ while retaining the full accessible count", () => {
    counts.a1.count = 100;
    render(<NavRail />);
    expect(screen.getByRole("button", { name: "Mail — 107 unread messages in all inboxes" }).textContent).toBe("99+");
  });
});
