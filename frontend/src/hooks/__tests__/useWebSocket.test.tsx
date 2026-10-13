import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebSocket } from "../useWebSocket";
import { useAuthStore, type Account } from "@/stores/useAuthStore";

class MockWebSocket {
  static sockets: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor() {
    MockWebSocket.sockets.push(this);
  }

  receive(accountId: string, type = "NewMessages") {
    this.onmessage?.({ data: JSON.stringify({ accountId, event: { type, data: { folder: "INBOX" } } }) });
  }
}

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
  vi.useFakeTimers();
  MockWebSocket.sockets = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  useAuthStore.setState({ accounts, activeAccountId: "first" });
  client = new QueryClient();
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mail event unread updates", () => {
  it.each(["NewMessages", "FlagsChanged", "FolderUpdated"])("refreshes only the inactive account's count for %s", (eventType) => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const onEvent = vi.fn();
    renderHook(() => useWebSocket(onEvent), { wrapper });

    act(() => {
      MockWebSocket.sockets[0].receive("second", eventType);
      vi.advanceTimersByTime(300);
    });

    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ["account-unread", "second"] });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("refreshes the active account's messages, folders and count", () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const onEvent = vi.fn();
    renderHook(() => useWebSocket(onEvent), { wrapper });

    act(() => {
      MockWebSocket.sockets[0].receive("first");
      vi.advanceTimersByTime(300);
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["account-unread", "first"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["messages", "INBOX"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["folders"] });
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it("refreshes all counts after connecting and reconnecting", () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useWebSocket(), { wrapper });
    act(() => MockWebSocket.sockets[0].onopen?.());
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: ["account-unread"] });
    act(() => {
      MockWebSocket.sockets[0].onclose?.();
      vi.advanceTimersByTime(1000);
    });
    expect(MockWebSocket.sockets).toHaveLength(2);
    act(() => MockWebSocket.sockets[1].onopen?.());
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing connection when adding, switching or removing accounts", () => {
    useAuthStore.setState({ accounts: [accounts[0]], activeAccountId: "first" });
    renderHook(() => useWebSocket(), { wrapper });
    const original = MockWebSocket.sockets[0];
    act(() => useAuthStore.getState().addAccount(accounts[1]));

    act(() => {
      useAuthStore.getState().setActiveAccount("second");
      useAuthStore.getState().setAccounts([...accounts].reverse());
      vi.advanceTimersByTime(30_000);
    });

    act(() => useAuthStore.getState().removeAccount("first"));
    expect(original.close).not.toHaveBeenCalled();
    expect(MockWebSocket.sockets).toHaveLength(1);
  });

  it("discards pending events and ignores late socket callbacks after unmounting", () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { unmount } = renderHook(() => useWebSocket(), { wrapper });
    const socket = MockWebSocket.sockets[0];
    act(() => socket.receive("second"));
    unmount();
    act(() => {
      socket.onclose?.();
      socket.receive("first");
      vi.advanceTimersByTime(30_000);
    });

    expect(invalidate).not.toHaveBeenCalled();
    expect(MockWebSocket.sockets).toHaveLength(1);
  });
});
