import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountUnreadCounts } from "../useAccountUnreadCounts";
import { apiGet } from "@/lib/api";
import { useAuthStore, type Account } from "@/stores/useAuthStore";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn() }));

const accounts: Account[] = ["first", "second"].map((id) => ({
  id,
  email: `${id}@example.com`,
  imapHost: "imap.example.com",
  smtpHost: "smtp.example.com",
}));
let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useAuthStore.setState({ accounts, activeAccountId: "first" });
});

afterEach(() => {
  cleanup();
  client.clear();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe("account Inbox unread counts", () => {
  it("keeps overlapping responses attached to their account when switching", async () => {
    const finish: Record<string, (value: { inbox_unread_count: number }) => void> = {};
    vi.mocked(apiGet).mockImplementation((_path, options) => new Promise((resolve) => {
      finish[options!.accountId!] = resolve;
    }));
    const { result } = renderHook(() => useAccountUnreadCounts(), { wrapper });
    expect(result.current.first.count).toBeUndefined();
    expect(result.current.second.count).toBeUndefined();
    expect(apiGet).toHaveBeenCalledWith("/account/unread", {
      accountId: "second", signal: expect.any(AbortSignal), handleSessionExpiry: false,
    });

    act(() => useAuthStore.getState().setActiveAccount("second"));
    act(() => finish.second({ inbox_unread_count: 9 }));
    await waitFor(() => expect(result.current.second.count).toBe(9));
    expect(result.current.first.count).toBeUndefined();
    act(() => finish.first({ inbox_unread_count: 2 }));
    await waitFor(() => expect(result.current.first.count).toBe(2));
    expect(client.getQueryData(["account-unread", "second"])).toEqual({ inbox_unread_count: 9 });
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed account unknown while displaying another account's real zero", async () => {
    vi.mocked(apiGet).mockImplementation((_path, options) => options?.accountId === "first"
      ? Promise.resolve({ inbox_unread_count: 0 })
      : Promise.reject(new Error("Mailbox unavailable")));
    const { result } = renderHook(() => useAccountUnreadCounts(), { wrapper });

    await waitFor(() => expect(result.current.second.isError).toBe(true));
    expect(result.current.first).toEqual({ count: 0, isLoading: false, isError: false });
    expect(result.current.second).toEqual({ count: undefined, isLoading: false, isError: true });
  });

  it("aborts a pending request when its account is removed", async () => {
    const signals: Record<string, AbortSignal> = {};
    vi.mocked(apiGet).mockImplementation((_path, options) => {
      signals[options!.accountId!] = options!.signal!;
      return new Promise(() => {});
    });
    const { result } = renderHook(() => useAccountUnreadCounts(), { wrapper });

    act(() => useAuthStore.getState().removeAccount("second"));

    expect(result.current.second).toBeUndefined();
    expect(signals.second.aborted).toBe(true);
    expect(signals.first.aborted).toBe(false);
  });

  it("polls every minute even without WebSocket events", async () => {
    vi.useFakeTimers();
    vi.mocked(apiGet).mockResolvedValue({ inbox_unread_count: 2 });
    renderHook(() => useAccountUnreadCounts(), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(apiGet).toHaveBeenCalledTimes(2);

    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(apiGet).toHaveBeenCalledTimes(4);
  });

  it("refreshes stale counts when returning to the window", async () => {
    vi.mocked(apiGet).mockResolvedValue({ inbox_unread_count: 3 });
    const { result } = renderHook(() => useAccountUnreadCounts(), { wrapper });
    await waitFor(() => expect(result.current.second.count).toBe(3));
    await client.invalidateQueries({ queryKey: ["account-unread"], refetchType: "none" });
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(4));
  });
});
