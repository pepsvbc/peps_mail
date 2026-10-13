import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("framer-motion", async () => {
  function AnimatePresence({ children }: { children: ReactNode }) {
    return <>{children}</>;
  }

  return {
    AnimatePresence,
    motion: {
      div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    },
  };
});

const { mockAuthState, mockUiState, mockUnreadCounts, mockQueryClient } = vi.hoisted(() => ({
  mockAuthState: {
    accounts: [
      { id: "a1", email: "admin@example.com", imapHost: "mail.example.com" },
      { id: "a2", email: "ops@example.com", imapHost: "imap.ops.example.com" },
    ],
    activeAccountId: "a1",
    setActiveAccount: vi.fn(),
    removeAccount: vi.fn(),
    setAccounts: vi.fn(),
  },
  mockUiState: {
    effectiveAnimationMode: "medium" as "rich" | "medium" | "subtle" | "off",
  },
  mockUnreadCounts: {} as Record<string, { count: number | undefined; isLoading: boolean; isError: boolean }>,
  mockQueryClient: { clear: vi.fn(), removeQueries: vi.fn() },
}));

vi.mock("@/hooks/useAccountUnreadCounts", () => ({
  useAccountUnreadCounts: () => mockUnreadCounts,
}));

vi.mock("@/stores/useAuthStore", () => ({
  useAuthStore: (selector: (state: typeof mockAuthState) => unknown) => selector(mockAuthState),
}));

vi.mock("@/stores/useUiStore", () => ({
  useUiStore: (selector: (state: typeof mockUiState) => unknown) => selector(mockUiState),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mockQueryClient,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  apiDelete: vi.fn(async () => ({})),
  apiPost: vi.fn(async () => ({})),
}));

vi.mock("../AddAccountModal", () => ({
  AddAccountModal: () => null,
}));

import { AccountSwitcher } from "../AccountSwitcher";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthState.activeAccountId = "a1";
  mockUnreadCounts.a1 = { count: 3, isLoading: false, isError: false };
  mockUnreadCounts.a2 = { count: 7, isLoading: false, isError: false };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AccountSwitcher motion transitions", () => {
  it("animates dropdown open path in non-off modes", () => {
    mockUiState.effectiveAnimationMode = "medium";
    render(<AccountSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: /admin@example.com/i }));
    expect(screen.getByTestId("account-switcher-dropdown-transition")).toBeTruthy();
  });

  it("keeps static dropdown in off mode", () => {
    mockUiState.effectiveAnimationMode = "off";
    render(<AccountSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: /admin@example.com/i }));
    expect(screen.queryByTestId("account-switcher-dropdown-transition")).toBeNull();
    expect(screen.getByText("Add account")).toBeTruthy();
  });
});

describe("account Inbox counts", () => {
  it("shows the other Inbox count without opening the menu or switching accounts", () => {
    render(<AccountSwitcher />);

    expect(screen.getByText("Other inbox: 7 unread")).toBeTruthy();
    expect(mockAuthState.setActiveAccount).not.toHaveBeenCalled();
  });

  it("shows a separate unread count for each account in the menu", () => {
    render(<AccountSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /admin@example.com/i }));

    const otherAccount = screen.getByRole("button", { name: /ops@example.com/i });
    expect(within(otherAccount).getByLabelText("7 unread messages in Inbox").textContent).toBe("7");
    expect(screen.getByLabelText("3 unread messages in Inbox").textContent).toBe("3");
  });

  it("shows a known empty Inbox as zero", () => {
    mockUnreadCounts.a2.count = 0;
    render(<AccountSwitcher />);
    expect(screen.getByText("Other inbox: 0 unread")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /admin@example.com/i }));
    expect(screen.getByLabelText("0 unread messages in Inbox").textContent).toBe("0");
  });

  it.each([false, true])("does not present an unknown Inbox count as zero (error=%s)", (isError) => {
    mockUnreadCounts.a2 = { count: undefined, isLoading: !isError, isError };
    render(<AccountSwitcher />);
    expect(screen.getByText(isError ? "Other inbox: unavailable" : "Other inbox: checking…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /admin@example.com/i }));
    expect(screen.queryByLabelText("0 unread messages in Inbox")).toBeNull();
    expect(screen.getByLabelText(isError ? "Unread Inbox count unavailable" : "Checking unread Inbox count")).toBeTruthy();
  });

  it("keeps unread caches when switching accounts while removing mailbox caches", async () => {
    vi.useFakeTimers();
    render(<AccountSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /admin@example.com/i }));
    fireEvent.click(screen.getByRole("button", { name: /ops@example.com/i }));
    await act(async () => { vi.advanceTimersByTime(150); });

    expect(mockAuthState.setActiveAccount).toHaveBeenCalledWith("a2");
    const { predicate } = mockQueryClient.removeQueries.mock.calls[0][0];
    expect(predicate({ queryKey: ["account-unread", "a1"] })).toBe(false);
    expect(predicate({ queryKey: ["account-unread", "a2"] })).toBe(false);
    expect(predicate({ queryKey: ["messages", "INBOX"] })).toBe(true);
    await act(async () => { vi.advanceTimersByTime(100); });
  });
});
