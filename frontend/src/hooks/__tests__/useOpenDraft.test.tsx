import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { apiGet, apiPost } from "@/lib/api";
import { useComposeStore } from "@/stores/useComposeStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useOpenDraft } from "../useOpenDraft";
import type { DraftDetail } from "../useCompose";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn() } }));
const draft: DraftDetail = {
  id: "draft-1", to: "to@example.com", cc: "cc@example.com", bcc: "bcc@example.com",
  subject: "Resume me", text_body: "Line one\nLine two", html_body: null,
  in_reply_to: "<parent@example.com>", references: "<thread@example.com>",
  attachments: [{ id: "attachment-1", filename: "file.pdf", content_type: "application/pdf", size: 50 }],
  created_at: "2026-10-14", updated_at: "2026-10-14",
};
function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(useOpenDraft, { wrapper });
}
beforeEach(() => {
  vi.resetAllMocks();
  useComposeStore.getState().reset();
  useAuthStore.setState({ activeAccountId: "account-a" });
  vi.mocked(apiGet).mockResolvedValue(draft);
  vi.mocked(apiPost).mockResolvedValue(draft);
});

describe("reopening drafts", () => {
  it("restores all fields and plaintext formatting", async () => {
    const { result } = setup();
    await act(() => result.current.openDraft({ id: draft.id }));
    expect(useComposeStore.getState()).toMatchObject({
      isOpen: true, draftId: draft.id, accountId: "account-a", to: draft.to, cc: draft.cc, bcc: draft.bcc,
      subject: draft.subject, body: draft.text_body, isHtml: false,
      inReplyTo: draft.in_reply_to, references: draft.references, showCc: true, showBcc: true,
      attachments: [{ id: "attachment-1", filename: "file.pdf", contentType: "application/pdf", size: 50 }],
    });
  });
  it("imports an IMAP draft and opens the saved HTML", async () => {
    vi.mocked(apiPost).mockResolvedValue({ ...draft, html_body: "<p>Saved HTML</p>" });
    const { result } = setup();
    await act(() => result.current.openDraft({ folder: "Brouillons", uid: 7 }));
    expect(apiPost).toHaveBeenCalledWith("/drafts/from-message", { folder: "Brouillons", uid: 7 });
    expect(useComposeStore.getState()).toMatchObject({ isOpen: true, isHtml: true, body: "<p>Saved HTML</p>" });
  });
  it("restores an already open draft without overwriting edits", async () => {
    const { result } = setup();
    await act(() => result.current.openDraft({ id: draft.id }));
    useComposeStore.getState().setField("body", "Unsaved edits");
    useComposeStore.getState().minimizeCompose();
    await act(() => result.current.openDraft({ id: draft.id }));
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(useComposeStore.getState()).toMatchObject({ isMinimized: false, body: "Unsaved edits" });
    expect(toast.info).not.toHaveBeenCalled();
  });
  it("explains when another composer prevents opening a draft", async () => {
    useComposeStore.getState().openCompose();
    useComposeStore.getState().setField("body", "Keep this");
    const { result } = setup();
    await act(() => result.current.openDraft({ id: draft.id }));
    expect(apiGet).not.toHaveBeenCalled();
    expect(useComposeStore.getState().body).toBe("Keep this");
    expect(toast.info).toHaveBeenCalled();
  });
  it("ignores a late response after switching accounts", async () => {
    let finish!: (d: DraftDetail) => void;
    vi.mocked(apiGet).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result } = setup();
    let opening!: Promise<void>;
    act(() => { opening = result.current.openDraft({ id: draft.id }); });
    useAuthStore.setState({ activeAccountId: "account-b" });
    await act(async () => { finish(draft); await opening; });
    expect(useComposeStore.getState().isOpen).toBe(false);
  });
  it("reports errors and allows retry", async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new Error("Network error"));
    const { result } = setup();
    await act(() => result.current.openDraft({ id: draft.id }));
    expect(toast.error).toHaveBeenCalled();
    expect(result.current.isPending).toBe(false);
    await act(() => result.current.openDraft({ id: draft.id }));
    expect(useComposeStore.getState().isOpen).toBe(true);
  });
});
