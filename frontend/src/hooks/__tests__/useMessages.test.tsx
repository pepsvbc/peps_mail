import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useDeleteMessage, useMessages, useMoveMessage, useUpdateFlags } from "../useMessages";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn(), apiPatch: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn() }));
vi.mock("@/lib/ws-context", () => ({ useWsStatus: () => ({ status: "connected" }) }));

describe("account unread updates", () => {
  it.each(["flags", "move", "delete"] as const)("refreshes account counts after a %s mutation", async (operation) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    vi.mocked(apiPatch).mockResolvedValue({ status: "ok" });
    vi.mocked(apiPost).mockResolvedValue({ status: "ok" });
    vi.mocked(apiDelete).mockResolvedValue({ status: "ok" });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, unmount } = renderHook(() => ({
      flags: useUpdateFlags(),
      move: useMoveMessage(),
      delete: useDeleteMessage(),
    }), { wrapper });

    act(() => {
      if (operation === "flags") result.current.flags.mutate({ folder: "INBOX", uid: 1, flags: ["\\Seen"], add: true });
      if (operation === "move") result.current.move.mutate({ fromFolder: "INBOX", toFolder: "Archive", uid: 1 });
      if (operation === "delete") result.current.delete.mutate({ folder: "INBOX", uid: 1 });
    });

    await waitFor(() => expect(result.current[operation].isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["account-unread"] });
    unmount();
    client.clear();
  });
});

describe("folder navigation", () => {
  it("never inserts the source UID into Spam during or after a move", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const source = { pages: [{ messages: [{ uid: 16891, folder: "INBOX" }], page: 0, per_page: 50, total_count: 1 }], pageParams: [0] };
    const destination = { pages: [{ messages: [], page: 0, per_page: 50, total_count: 0 }], pageParams: [0] };
    client.setQueryData(["messages", "INBOX"], source);
    client.setQueryData(["messages", "Spam"], destination);
    client.setQueryData(["search", "test"], { results: [{ uid: 16891, folder: "INBOX" }], total_count: 1, query: "test" });
    let finish!: () => void;
    vi.mocked(apiPost).mockImplementation(() => new Promise(resolve => { finish = () => resolve({ status: "ok" }); }));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, unmount } = renderHook(() => useMoveMessage(), { wrapper });
    act(() => result.current.mutate({ fromFolder: "INBOX", toFolder: "Spam", uid: 16891 }));
    await waitFor(() => expect(finish).toBeDefined());
    expect(client.getQueryData(["messages", "Spam"])).toEqual(destination);
    expect(client.getQueryData(["search", "test"])).toEqual({ results: [], total_count: 0, query: "test" });
    act(() => finish());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(["messages", "Spam"])).toEqual(destination);
    unmount();
    client.clear();
  });
  it("restores an optimistically hidden search result when moving fails", async () => {
    const client = new QueryClient();
    const search = { results: [{ uid: 7, folder: "INBOX" }], total_count: 1, query: "test" };
    client.setQueryData(["search", "test"], search);
    let fail!: () => void;
    vi.mocked(apiPost).mockImplementation(() => new Promise((_resolve, reject) => { fail = () => reject(new Error("Move failed")); }));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result, unmount } = renderHook(() => useMoveMessage(), { wrapper });
    act(() => result.current.mutate({ fromFolder: "INBOX", toFolder: "Spam", uid: 7 }));
    await waitFor(() => expect(fail).toBeDefined());
    expect(client.getQueryData(["search", "test"])).toEqual({ ...search, results: [], total_count: 0 });
    act(() => fail());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(["search", "test"])).toEqual(search);
    unmount();
    client.clear();
  });

  it("does not show Inbox data while Junk is loading", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(apiGet).mockImplementation((url) => url.includes("/INBOX/")
      ? Promise.resolve({ messages: [{ uid: 1, folder: "INBOX" }], page: 0, per_page: 50, total_count: 1 })
      : new Promise(() => {}));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender, unmount } = renderHook(({ folder }) => useMessages(folder), {
      initialProps: { folder: "INBOX" }, wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender({ folder: "Junk" });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPending).toBe(true);
    unmount();
    client.clear();
  });
});

describe("inbox synchronization fallback", () => {
  it("polls pending background sync and continues refreshing after it completes", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const response = { messages: [], page: 0, per_page: 50, total_count: 0 };
    vi.mocked(apiGet).mockReset();
    vi.mocked(apiGet).mockResolvedValueOnce({ ...response, syncing: true }).mockResolvedValue({ ...response, syncing: false });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { unmount } = renderHook(() => useMessages("INBOX"), { wrapper });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(apiGet).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(apiGet).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(apiGet).toHaveBeenCalledTimes(3);
    } finally {
      unmount();
      client.clear();
      vi.useRealTimers();
    }
  });
});
