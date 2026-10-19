import { beforeEach, describe, expect, it } from "vitest";
import { useComposeStore, useComposeWindows, type DraftResumeParams } from "../useComposeStore";

const draft: DraftResumeParams = {
  id: "match-report-draft",
  to: "team@example.com",
  cc: "coach@example.com",
  bcc: "committee@example.com",
  subject: "Match report",
  body: "<p>See the attached report.</p>",
  inReplyTo: "<original@example.com>",
  references: "<original@example.com>",
  attachments: [
    { id: "report", filename: "report.pdf", contentType: "application/pdf", size: 120 },
  ],
  isHtml: true,
};

describe("composer window state", () => {
  beforeEach(() => {
    useComposeStore.getState().reset();
    useComposeWindows.setState({ windows: [], focusedStore: null });
  });

  it("minimizes and restores a draft without losing its fields or attachments", () => {
    useComposeStore.getState().openDraft(draft);
    const content = useComposeStore.getState();

    useComposeStore.getState().minimizeCompose();
    expect(useComposeStore.getState()).toMatchObject({
      ...content,
      isOpen: true,
      isMinimized: true,
    });

    useComposeStore.getState().restoreCompose();
    expect(useComposeStore.getState()).toMatchObject({
      ...content,
      isOpen: true,
      isMinimized: false,
    });
  });

  it("prefills a new message from an address without overwriting an existing minimized draft", () => {
    useComposeStore.getState().openCompose("coach@example.com");
    expect(useComposeStore.getState()).toMatchObject({
      isOpen: true, to: "coach@example.com", body: "", subject: "",
    });
    useComposeStore.getState().setField("body", "A message to the coach.");
    useComposeStore.getState().minimizeCompose();

    useComposeStore.getState().openCompose("another@example.com");

    expect(useComposeStore.getState()).toMatchObject({
      isOpen: true, isMinimized: true,
      to: "coach@example.com", body: "A message to the coach.",
    });
  });

  it("creates independent messages on every new-message request", () => {
    useComposeStore.getState().openDraft(draft);
    useComposeStore.getState().openCompose("one@example.com");
    useComposeStore.getState().openCompose("two@example.com");
    const [first, second] = useComposeWindows.getState().windows;
    first.store.getState().setField("body", "First message");
    second.store.getState().setField("body", "Second message");
    expect(useComposeStore.getState().draftId).toBe(draft.id);
    expect(first.store.getState()).toMatchObject({ to: "one@example.com", body: "First message" });
    expect(second.store.getState()).toMatchObject({ to: "two@example.com", body: "Second message" });
    first.store.getState().reset();
    expect(second.store.getState().isOpen).toBe(true);
    expect(useComposeStore.getState().isOpen).toBe(true);
  });

  it.each([
    ["reply", () => useComposeStore.getState().openReply({
      to: "other@example.com", cc: "", subject: "Another reply", body: "Other body",
      inReplyTo: null, references: null,
    })],
    ["forward", () => useComposeStore.getState().openForward({
      subject: "Another forward", body: "Other body",
    })],
    ["another draft", () => useComposeStore.getState().openDraft({
      ...draft, id: "other-draft", subject: "Other draft",
    })],
  ])("restores the current minimized draft when opening %s instead of replacing it", (_name, open) => {
    useComposeStore.getState().openDraft(draft);
    const content = useComposeStore.getState();
    useComposeStore.getState().minimizeCompose();

    open();

    expect(useComposeStore.getState()).toMatchObject({
      ...content,
      isOpen: true,
      isMinimized: false,
    });
  });

  it.each(["reply", "forward", "draft"])("opens a separate %s while a previous message is pending send", (kind) => {
    useComposeStore.getState().openDraft(draft);
    useComposeStore.setState({ isOpen: false, pendingSend: true });
    if (kind === "reply") useComposeStore.getState().openReply({ to: "other@example.com", cc: "", subject: "Next reply", body: "New text", inReplyTo: null, references: null });
    if (kind === "forward") useComposeStore.getState().openForward({ subject: "Next forward", body: "New text" });
    if (kind === "draft") useComposeStore.getState().openDraft({ ...draft, id: "next-draft", body: "New text" });
    expect(useComposeStore.getState()).toMatchObject({ pendingSend: true, draftId: draft.id, body: draft.body });
    const next = useComposeWindows.getState().windows[0].store;
    useComposeStore.getState().reset();
    expect(next.getState()).toMatchObject({ isOpen: true, body: "New text" });
  });

  it("starts the next message restored after closing or discarding a minimized draft", () => {
    useComposeStore.getState().openDraft(draft);
    useComposeStore.getState().minimizeCompose();
    useComposeStore.getState().closeCompose();
    expect(useComposeStore.getState()).toMatchObject({ isOpen: false, isMinimized: false });

    useComposeStore.getState().openCompose();
    expect(useComposeStore.getState()).toMatchObject({
      isOpen: true, isMinimized: false, subject: "", body: "", attachments: [], draftId: null,
    });

    useComposeStore.getState().minimizeCompose();
    useComposeStore.getState().reset();
    expect(useComposeStore.getState()).toMatchObject({ isOpen: false, isMinimized: false });
  });
});
