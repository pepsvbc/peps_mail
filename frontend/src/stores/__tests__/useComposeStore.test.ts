import { beforeEach, describe, expect, it } from "vitest";
import { useComposeStore, type DraftResumeParams } from "../useComposeStore";

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
      isOpen: true, isMinimized: false,
      to: "coach@example.com", body: "A message to the coach.",
    });
  });

  it.each([
    ["new message", () => useComposeStore.getState().openCompose()],
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
