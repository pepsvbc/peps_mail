import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { apiDelete, apiPost } from "@/lib/api";
import { useComposeStore } from "@/stores/useComposeStore";
import { useDeleteDraft, useSaveDraft } from "../useCompose";

vi.mock("@/lib/api", () => ({ apiDelete: vi.fn(), apiPost: vi.fn() }));

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(useDeleteDraft, { wrapper });
}

beforeEach(() => {
  vi.resetAllMocks();
  useComposeStore.getState().reset();
  useComposeStore.setState({ isOpen: true, draftId: "draft-1", body: "Current edits" });
});

describe("deleting drafts from outside the composer", () => {
  it("closes the matching editor so autosave cannot recreate a deleted draft", async () => {
    vi.mocked(apiDelete).mockResolvedValue({ status: "deleted" });
    const { result } = setup();
    await act(() => result.current.mutateAsync("draft-1"));
    expect(useComposeStore.getState()).toMatchObject({ isOpen: false, draftId: null });
  });

  it("retains the editor when deletion fails", async () => {
    vi.mocked(apiDelete).mockRejectedValue(new Error("Offline"));
    const { result } = setup();
    await act(async () => {
      await expect(result.current.mutateAsync("draft-1")).rejects.toThrow("Offline");
    });
    expect(useComposeStore.getState()).toMatchObject({ isOpen: true, body: "Current edits" });
  });

  it("does not close another draft", async () => {
    vi.mocked(apiDelete).mockResolvedValue({ status: "deleted" });
    const { result } = setup();
    await act(() => result.current.mutateAsync("draft-2"));
    expect(useComposeStore.getState()).toMatchObject({ isOpen: true, draftId: "draft-1" });
  });
});

it("requests durable local saving without waiting for IMAP", async () => {
  vi.mocked(apiPost).mockResolvedValue({ id: "reply-1", status: "saved_locally" });
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(useSaveDraft, { wrapper });
  await act(() => result.current.mutateAsync({
    id: "reply-1", to: "sender@example.com", cc: "", bcc: "", subject: "Re: Hello",
    textBody: "Reply", htmlBody: null, inReplyTo: "<original@example.com>", references: null,
  }));
  expect(apiPost).toHaveBeenCalledWith("/drafts", expect.objectContaining({
    id: "reply-1", defer_sync: true, in_reply_to: "<original@example.com>",
  }));
});
