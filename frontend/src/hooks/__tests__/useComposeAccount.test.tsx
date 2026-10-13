import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { apiDelete, apiGet, apiGetBlob, apiPost, apiPostFormData } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useComposeStore } from "@/stores/useComposeStore";
import { useComposeAccount } from "../useComposeAccount";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn(), apiGetBlob: vi.fn(), apiPost: vi.fn(), apiPostFormData: vi.fn(), apiDelete: vi.fn() }));
function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { ...renderHook(useComposeAccount, { wrapper }), client };
}
beforeEach(() => {
  vi.resetAllMocks();
  useAuthStore.setState({ activeAccountId: "a", accounts: ["a", "b"].map(id => ({ id, email: `${id}@example.com`, imapHost: "imap", smtpHost: "smtp" })) });
  useComposeStore.getState().reset();
  useComposeStore.getState().openDraft({ id: "original", to: "to@example.com", cc: "cc@example.com", bcc: "bcc@example.com", subject: "Keep me",
    body: '<p>Draft body</p><img src="/api/drafts/original/attachments/file/content">', inReplyTo: "<parent>", references: "<thread>",
    attachments: [{ id: "file", filename: "file.png", contentType: "image/png", size: 4 }],
  });
  vi.mocked(apiGet).mockResolvedValue({ identities: [{ id: 20, email: "b@example.com", signature_html: "<p>B signature</p>", is_default: true }] });
  vi.mocked(apiGetBlob).mockResolvedValue(new Blob(["file"]));
  vi.mocked(apiPostFormData).mockResolvedValue({ attachments: [{ id: "copied-file", filename: "file.png", content_type: "image/png", size: 4 }] });
  vi.mocked(apiPost).mockResolvedValue({ status: "saved" });
  vi.mocked(apiDelete).mockResolvedValue({ status: "deleted" });
});
describe("switching the sending account", () => {
  it("copies attachments and message before changing the account used for sending", async () => {
    const { result, client } = setup();
    client.setQueryData(["message", "INBOX", 1], { subject: "Private to A" });
    await act(() => result.current.mutateAsync("b"));
    const draft = useComposeStore.getState();
    expect(draft).toMatchObject({ accountId: "b", to: "to@example.com", cc: "cc@example.com", bcc: "bcc@example.com", subject: "Keep me", fromIdentityId: 20 });
    expect(useAuthStore.getState().activeAccountId).toBe("b");
    expect(draft.body).toContain(`/api/drafts/${draft.draftId}/attachments/copied-file/content`);
    expect(draft.attachments[0].id).toBe("copied-file");
    expect(apiGetBlob).toHaveBeenCalledWith("/drafts/original/attachments/file/content", "a");
    expect(apiPostFormData).toHaveBeenCalledWith(`/drafts/${draft.draftId}/attachments`, expect.any(FormData), { accountId: "b" });
    expect(apiPost).toHaveBeenCalledWith("/drafts", expect.objectContaining({ id: draft.draftId, html_body: draft.body, in_reply_to: "<parent>", references: "<thread>" }), { accountId: "b" });
    expect(apiDelete).toHaveBeenCalledWith("/drafts/original", { accountId: "a" });
    expect(client.getQueryData(["message", "INBOX", 1])).toBeUndefined();
  });
  it("keeps the original draft and account when an attachment transfer fails", async () => {
    vi.mocked(apiPostFormData).mockRejectedValue(new Error("Upload failed"));
    const before = useComposeStore.getState();
    const { result } = setup();
    await act(async () => { await expect(result.current.mutateAsync("b")).rejects.toThrow("Upload failed"); });
    expect(useComposeStore.getState()).toBe(before);
    expect(useAuthStore.getState().activeAccountId).toBe("a");
    expect(apiDelete).not.toHaveBeenCalledWith("/drafts/original", expect.anything());
    expect(apiDelete).toHaveBeenCalledWith(expect.any(String), { accountId: "b" });
  });
  it("switches an empty composer without creating an empty saved draft", async () => {
    useComposeStore.getState().reset();
    useComposeStore.getState().openCompose();
    vi.mocked(apiGet).mockResolvedValue({ identities: [] });
    const { result } = setup();
    await act(() => result.current.mutateAsync("b"));
    expect(useComposeStore.getState()).toMatchObject({ accountId: "b", draftId: null, body: "" });
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("does not overwrite a mailbox switch that happens during the copy", async () => {
    let finish!: (result: unknown) => void;
    vi.mocked(apiPost).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result } = setup();
    let switching!: Promise<void>;
    await act(async () => { switching = result.current.mutateAsync("b"); });
    useAuthStore.setState({ activeAccountId: "another-account" });
    await act(async () => {
      finish({ status: "saved" });
      await expect(switching).rejects.toThrow("The active draft changed");
    });
    expect(useComposeStore.getState()).toMatchObject({ accountId: "a", draftId: "original" });
    expect(useAuthStore.getState().activeAccountId).toBe("another-account");
    expect(apiDelete).not.toHaveBeenCalledWith("/drafts/original", expect.anything());
  });

  it("does not change sender until copying has finished", async () => {
    let finish!: (result: unknown) => void;
    vi.mocked(apiPost).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result } = setup();
    let switching!: Promise<void>;
    await act(async () => { switching = result.current.mutateAsync("b"); });
    expect(useAuthStore.getState().activeAccountId).toBe("a");
    expect(useComposeStore.getState().draftId).toBe("original");
    await act(async () => { finish({ status: "saved" }); await switching; });
    expect(useAuthStore.getState().activeAccountId).toBe("b");
  });
});
