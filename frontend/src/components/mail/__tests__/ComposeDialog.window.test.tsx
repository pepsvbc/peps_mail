import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposeStore } from "@/stores/useComposeStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useUiStore } from "@/stores/useUiStore";
import type { Identity } from "@/types/identity";
import { ComposeDialog } from "../ComposeDialog";

const { saveDraft, sendMessage, identities } = vi.hoisted(() => ({
  saveDraft: { isPending: false, mutate: vi.fn() },
  sendMessage: { isPending: false, mutate: vi.fn() },
  identities: { data: [] as Identity[] },
}));

vi.mock("@/hooks/useCompose", () => ({
  useSaveDraft: () => saveDraft,
  useSendMessage: () => sendMessage,
  useUploadAttachment: () => ({ isPending: false, mutate: vi.fn() }),
  useDeleteAttachment: () => ({ mutate: vi.fn() }),
  useDeleteDraft: () => ({ mutate: vi.fn() }),
}));

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
    identities.data = [];
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
