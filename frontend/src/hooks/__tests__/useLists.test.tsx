import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import type { DistributionList } from "@/types/list";
import { useCreateList, useDeleteList, useIsAdmin, useListUsers, useLists, useUpdateList } from "../useLists";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));

const list: DistributionList = {
  id: "list-1", name: "Équipe U13", kind: "personal", display_mode: "list", owner_email: "me@example.com",
  members: [{ email: "lea@example.com", name: "Léa" }], can_edit: true, can_manage: true, access: null,
  created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z",
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, invalidate, wrapper };
}

function setAdmin(isAdmin: boolean) {
  useAuthStore.setState({
    activeAccountId: "a",
    accounts: [
      { id: "a", email: "me@example.com", imapHost: "imap", smtpHost: "smtp", isAdmin },
      { id: "b", email: "other@example.com", imapHost: "imap", smtpHost: "smtp", isAdmin: !isAdmin },
    ],
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  setAdmin(false);
});

describe("distribution list hooks", () => {
  it("loads the lists visible to the active account", async () => {
    vi.mocked(apiGet).mockResolvedValue({ lists: [list] });
    const { wrapper } = setup();
    const { result } = renderHook(useLists, { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([list]));
    expect(apiGet).toHaveBeenCalledWith("/lists");
  });

  it("creates, updates and deletes lists and refreshes them afterwards", async () => {
    vi.mocked(apiPost).mockResolvedValue(list);
    vi.mocked(apiPut).mockResolvedValue(list);
    vi.mocked(apiDelete).mockResolvedValue({ status: "deleted" });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => ({ create: useCreateList(), update: useUpdateList(), remove: useDeleteList() }), { wrapper });

    await act(() => result.current.create.mutateAsync({ name: "Équipe U13", kind: "personal", display_mode: "list", members: list.members }));
    expect(apiPost).toHaveBeenCalledWith("/lists", { name: "Équipe U13", kind: "personal", display_mode: "list", members: list.members });

    await act(() => result.current.update.mutateAsync({ id: "list-1", data: { display_mode: "expanded" } }));
    expect(apiPut).toHaveBeenCalledWith("/lists/list-1", { display_mode: "expanded" });

    await act(() => result.current.remove.mutateAsync("list-1"));
    expect(apiDelete).toHaveBeenCalledWith("/lists/list-1");

    expect(invalidate).toHaveBeenCalledTimes(3);
    for (const call of invalidate.mock.calls) expect(call[0]).toEqual({ queryKey: ["lists"] });
  });

  it("only loads the people picker for admins of the active account", async () => {
    vi.mocked(apiGet).mockResolvedValue({ users: [{ email: "coach@example.com", last_login: "2026-11-01T00:00:00Z" }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => ({ users: useListUsers(), isAdmin: useIsAdmin() }), { wrapper });
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.users.fetchStatus).toBe("idle");
    expect(apiGet).not.toHaveBeenCalled();

    act(() => setAdmin(true));
    await waitFor(() => expect(result.current.users.data).toEqual([{ email: "coach@example.com", last_login: "2026-11-01T00:00:00Z" }]));
    expect(result.current.isAdmin).toBe(true);
    expect(apiGet).toHaveBeenCalledWith("/lists/users");
  });
});
