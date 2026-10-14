import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposeStore } from "@/stores/useComposeStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useUiStore } from "@/stores/useUiStore";
import type { Identity } from "@/types/identity";
import { ComposeDialog } from "../ComposeDialog";
import { toast } from "sonner";

const { saveDraft, sendMessage, uploadAttachment, switchAccount, identities } = vi.hoisted(() => ({
  saveDraft: { isPending: false, mutate: vi.fn() },
  sendMessage: { isPending: false, mutate: vi.fn() },
  switchAccount: { isPending: false, mutate: vi.fn() },
  uploadAttachment: { isPending: false, mutate: vi.fn() },
  identities: { data: [] as Identity[] },
}));

vi.mock("@/hooks/useCompose", () => ({
  useSaveDraft: () => saveDraft,
  useSendMessage: () => sendMessage,
  useUploadAttachment: () => uploadAttachment,
  useDeleteAttachment: () => ({ mutate: vi.fn() }),
  useDeleteDraft: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/hooks/useComposeAccount", () => ({ useComposeAccount: () => switchAccount }));

vi.mock("@/hooks/useIdentities", () => ({
  useIdentities: () => identities,
}));

vi.mock("@/hooks/useAutocomplete", () => ({
  useAutocomplete: () => ({ results: [], isLoading: false }),
}));

vi.mock("next/dynamic", () => ({
  default: () => function TestEditor({ content, onChange }: {
    content: string;
    onChange: (content: string) => void;
  }) {
    return <textarea aria-label="Message body" value={content} onChange={(event) => onChange(event.target.value)} />;
  },
}));

function openComposer() {
  useComposeStore.getState().openDraft({
    id: "club-news-draft",
    to: "team@example.com",
    cc: "coach@example.com",
    bcc: "",
    subject: "Club news",
    body: "<p>Training on Tuesday.</p>",
    inReplyTo: null,
    references: null,
    attachments: [
      { id: "schedule", filename: "schedule.pdf", contentType: "application/pdf", size: 1024 },
    ],
    isHtml: true,
  });
}

describe("composer window controls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    identities.data = [];
    uploadAttachment.isPending = false;
    useUiStore.setState({ effectiveAnimationMode: "off" });
    useAuthStore.setState({
      activeAccountId: "account-a",
      accounts: [
        { id: "account-a", email: "a@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com" },
        { id: "account-b", email: "b@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com" },
      ],
    });
    useComposeStore.getState().reset();
    openComposer();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("always shows the account address in From, including without saved identities", () => {
    render(<ComposeDialog />);
    expect(screen.getByRole("combobox", { name: "From" })).toHaveTextContent("a@example.com");
  });

  it("sends with the selected sender identity", () => {
    identities.data = [
      { id: 1, email: "a@example.com", display_name: "", signature_html: "", is_default: true, created_at: "", updated_at: "" },
      { id: 2, email: "club@example.com", display_name: "Club", signature_html: "", is_default: false, created_at: "", updated_at: "" },
    ];
    render(<ComposeDialog />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Sender address" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "Club <club@example.com>" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(sendMessage.mutate).toHaveBeenCalledWith(expect.objectContaining({ fromIdentityId: 2 }), expect.any(Object));
  });

  it("offers all logged-in accounts in From", () => {
    render(<ComposeDialog />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "From" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "b@example.com" }));
    expect(switchAccount.mutate).toHaveBeenCalledWith("account-b", expect.any(Object));
    expect(screen.getByRole("combobox", { name: "From" })).toBeInTheDocument();
  });

  it("opens the file picker and adds the uploaded attachment", () => {
    render(<ComposeDialog />);
    const input = screen.getByLabelText("Attach files", { selector: "input" });
    const picker = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(picker).toHaveBeenCalledOnce();
    const file = new File(["Club schedule"], "new-schedule.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(uploadAttachment.mutate).toHaveBeenCalledWith({ draftId: "club-news-draft", files: [file] }, expect.any(Object));
    act(() => uploadAttachment.mutate.mock.calls[0][1].onSuccess({ attachments: [
      { id: "new-file", filename: "new-schedule.txt", content_type: "text/plain", size: 13 },
    ] }));
    expect(screen.getByText("new-schedule.txt")).toBeInTheDocument();
  });

  it("waits for attachment uploads before allowing send or its keyboard shortcut", () => {
    uploadAttachment.isPending = true;
    render(<ComposeDialog />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(sendMessage.mutate).not.toHaveBeenCalled();
    expect(useComposeStore.getState().isOpen).toBe(true);
  });

  it("closes an empty new message without creating a draft", () => {
    useComposeStore.getState().reset();
    useComposeStore.getState().openCompose();
    render(<ComposeDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Close composer" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useComposeStore.getState().isOpen).toBe(false);
    expect(saveDraft.mutate).not.toHaveBeenCalled();
  });

  it.each([true, false])("saves and closes a new message when randomUUID is available: %s", (hasRandomUUID) => {
    if (!hasRandomUUID) {
      vi.stubGlobal("crypto", {
        getRandomValues: crypto.getRandomValues.bind(crypto),
      });
    }
    useComposeStore.getState().reset();
    useComposeStore.getState().openCompose();
    render(<ComposeDialog />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message body" }), {
      target: { value: "<p>Training on Tuesday.</p>" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Close composer" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useComposeStore.getState().isOpen).toBe(false);
    expect(saveDraft.mutate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      htmlBody: "<p>Training on Tuesday.</p>",
    }), expect.any(Object));
    expect(sendMessage.mutate).not.toHaveBeenCalled();
  });

  it("saves and closes a signature-only message without randomUUID", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });
    identities.data = [{
      id: 1,
      display_name: "Coach",
      email: "coach@example.com",
      signature_html: "<p>Coach</p>",
      is_default: true,
      created_at: "2026-10-13T00:00:00Z",
      updated_at: "2026-10-13T00:00:00Z",
    }];
    useComposeStore.getState().reset();
    useComposeStore.getState().openCompose();
    render(<ComposeDialog />);
    const signatureBody = useComposeStore.getState().body;
    expect(signatureBody).toContain(identities.data[0].signature_html);

    fireEvent.click(screen.getByRole("button", { name: "Close composer" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useComposeStore.getState().isOpen).toBe(false);
    expect(saveDraft.mutate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      htmlBody: signatureBody,
    }), expect.any(Object));
  });

  it("does not add another signature when reopening a saved draft", () => {
    identities.data = [{
      id: 1, display_name: "Coach", email: "coach@example.com", signature_html: "<p>Coach</p>",
      is_default: true, created_at: "2026-10-13", updated_at: "2026-10-13",
    }];
    useComposeStore.getState().reset();
    const body = "<p>My saved message</p><p>My existing signature</p>";
    useComposeStore.getState().openDraft({
      id: "saved-draft", to: "bob@example.com", cc: "", bcc: "", subject: "Saved", body,
      inReplyTo: null, references: null, attachments: [],
    });
    render(<ComposeDialog />);
    expect(useComposeStore.getState().body).toBe(body);
    expect(useComposeStore.getState().signatureHtml).toBe("<p>Coach</p>");
  });

  it("keeps the editor mounted and all content intact while minimized", () => {
    render(<ComposeDialog />);
    const editor = screen.getByRole("textbox", { name: "Message body" });
    const recipient = screen.getByPlaceholderText("Recipients");
    fireEvent.change(recipient, { target: { value: "team@example.com, unfinished" } });
    fireEvent.change(editor, { target: { value: "<p>Updated schedule.</p>" } });

    fireEvent.click(screen.getByRole("button", { name: "Minimize composer" }));

    expect(editor).toBeInTheDocument();
    expect(editor).not.toBeVisible();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Restore composer" })).toHaveTextContent("Club news");
    expect(useComposeStore.getState()).toMatchObject({
      isOpen: true, isMinimized: true, draftId: "club-news-draft",
      to: "team@example.com, unfinished", cc: "coach@example.com",
      body: "<p>Updated schedule.</p>",
      attachments: [{ id: "schedule", filename: "schedule.pdf" }],
    });

    fireEvent.click(screen.getByRole("button", { name: "Restore composer" }));

    expect(screen.getByRole("textbox", { name: "Message body" })).toBe(editor);
    expect(editor).toBeVisible();
    expect(recipient).toHaveValue("team@example.com, unfinished");
    expect(screen.getByText("schedule.pdf")).toBeVisible();
  });

  it("allows mailbox interaction without dismissing or saving the composer", () => {
    const navigate = vi.fn();
    render(<><button onClick={navigate}>Open inbox</button><ComposeDialog /></>);
    const inbox = screen.getByRole("button", { name: "Open inbox" });

    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.pointerDown(inbox);
    fireEvent.click(inbox);
    act(() => { inbox.focus(); });
    expect(navigate).toHaveBeenCalledOnce();
    expect(inbox).toHaveFocus();
    expect(useComposeStore.getState().isOpen).toBe(true);
    expect(saveDraft.mutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Minimize composer" }));
    fireEvent.pointerDown(inbox);
    fireEvent.click(inbox);
    act(() => { inbox.focus(); });
    fireEvent.keyDown(inbox, { key: "Escape" });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(inbox).toHaveFocus();
    expect(useComposeStore.getState()).toMatchObject({ isOpen: true, isMinimized: true });
    expect(saveDraft.mutate).not.toHaveBeenCalled();
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("can dock on either side and minimize a maximized composer", () => {
    render(<ComposeDialog />);
    const composer = screen.getByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Move composer to left" }));
    expect(screen.getByRole("button", { name: "Move composer to right" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Move composer to left" })).toBeNull();
    const leftClasses = composer.className;

    fireEvent.click(screen.getByRole("button", { name: "Maximize composer" }));
    expect(screen.getByRole("button", { name: "Restore composer size" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Minimize composer" }));
    expect(screen.getByRole("button", { name: "Restore composer" })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Message body" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Restore composer" }));
    const restoreSize = screen.queryByRole("button", { name: "Restore composer size" });
    if (restoreSize) fireEvent.click(restoreSize);
    expect(composer.className).toBe(leftClasses);

    fireEvent.click(screen.getByRole("button", { name: "Move composer to right" }));
    expect(screen.getByRole("button", { name: "Move composer to left" })).toBeVisible();
    expect(composer.className).not.toBe(leftClasses);
  });

  it("keeps the chosen side for the next message within the same session", () => {
    render(<ComposeDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Move composer to left" }));
    fireEvent.click(screen.getByRole("button", { name: "Close composer" }));
    act(() => { useComposeStore.getState().openCompose(); });

    expect(screen.getByRole("button", { name: "Move composer to right" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Minimize composer" })).toBeVisible();
  });

  it("continues autosaving edits while minimized and explicitly saves on close", () => {
    render(<ComposeDialog />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message body" }), {
      target: { value: "<p>Updated training time.</p>" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Minimize composer" }));
    act(() => { vi.advanceTimersByTime(30000); });

    expect(saveDraft.mutate).toHaveBeenCalledWith(expect.objectContaining({
      id: "club-news-draft", htmlBody: "<p>Updated training time.</p>",
    }), expect.any(Object));
    expect(useComposeStore.getState().isOpen).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Close composer" }));
    expect(saveDraft.mutate).toHaveBeenCalledTimes(2);
    expect(useComposeStore.getState().isOpen).toBe(false);
    expect(sendMessage.mutate).not.toHaveBeenCalled();
  });

  it("pauses draft saves while browsing another account and retains the original message", () => {
    render(<ComposeDialog />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message body" }), {
      target: { value: "<p>Private account A draft.</p>" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Minimize composer" }));
    act(() => { useAuthStore.setState({ activeAccountId: "account-b" }); });
    act(() => { vi.advanceTimersByTime(30000); });

    expect(saveDraft.mutate).not.toHaveBeenCalled();
    expect(sendMessage.mutate).not.toHaveBeenCalled();
    expect(useComposeStore.getState()).toMatchObject({
      isOpen: true, isMinimized: true,
      draftId: "club-news-draft", body: "<p>Private account A draft.</p>",
    });

    fireEvent.click(screen.getByRole("button", { name: "Restore composer" }));
    expect(screen.getByText("Switch back to this draft's account to continue composing.")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Message body" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(sendMessage.mutate).not.toHaveBeenCalled();

    act(() => { useAuthStore.setState({ activeAccountId: "account-a" }); });
    act(() => { vi.advanceTimersByTime(30000); });
    expect(saveDraft.mutate).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Message body" })).toHaveValue("<p>Private account A draft.</p>");
  });

  it.each([true, false])("reports Sent-copy status separately from delivery (saved=%s)", (saved) => {
    const warning = vi.spyOn(toast, "warning").mockReturnValue("warning");
    const success = vi.spyOn(toast, "success").mockReturnValue("success");
    render(<ComposeDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(sendMessage.mutate).toHaveBeenCalledOnce();
    act(() => {
      sendMessage.mutate.mock.calls[0][1].onSuccess({
        status: "sent", message_id: "<sent@example.com>", sent_copy_saved: saved,
      });
    });
    if (saved) {
      expect(success).toHaveBeenCalledWith("Message sent");
      expect(warning).not.toHaveBeenCalled();
    } else {
      expect(warning).toHaveBeenCalledWith(
        "Message sent, but a copy could not be saved to Sent. Do not resend.",
        expect.objectContaining({ duration: 10000 }),
      );
      expect(success).not.toHaveBeenCalled();
    }
    expect(useComposeStore.getState()).toMatchObject({ isOpen: false, subject: "", body: "" });
    expect(sendMessage.mutate).toHaveBeenCalledOnce();
  });

  it("does not send through another account when it changes during the undo window", () => {
    render(<ComposeDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(useComposeStore.getState().isOpen).toBe(false);

    act(() => { useAuthStore.setState({ activeAccountId: "account-b" }); });
    act(() => { vi.advanceTimersByTime(5000); });

    expect(sendMessage.mutate).not.toHaveBeenCalled();
    expect(useComposeStore.getState()).toMatchObject({
      isOpen: true, draftId: "club-news-draft", subject: "Club news", to: "team@example.com",
    });
  });
});
