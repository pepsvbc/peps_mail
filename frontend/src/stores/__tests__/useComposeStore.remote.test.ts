import { beforeEach, describe, expect, it } from "vitest";
import { useComposeStore, useComposeWindows } from "../useComposeStore";

const quote = { kind: "reply" as const, html: '<p>Hi</p><img src="https://t.example/p.gif">', text: "Hi" };
const reply = { to: "a@example.com", cc: "", subject: "Re: x", body: "<p></p>", quote, inReplyTo: null, references: null };

describe("remote content in quoted history", () => {
  beforeEach(() => {
    useComposeStore.getState().reset();
    useComposeWindows.setState({ windows: [], focusedStore: null });
  });

  it("blocks remote content in the quote preview unless it was allowed for the original", () => {
    useComposeStore.getState().openReply(reply);
    expect(useComposeStore.getState().quoteRemoteAllowed).toBe(false);
    useComposeStore.getState().reset();

    useComposeStore.getState().openReply({ ...reply, remoteContentAllowed: true });
    expect(useComposeStore.getState().quoteRemoteAllowed).toBe(true);
    useComposeStore.getState().removeQuote();
    expect(useComposeStore.getState().quoteRemoteAllowed).toBe(false);
  });

  it("carries the choice into forwards and always blocks for resumed drafts", () => {
    useComposeStore.getState().openForward({ subject: "Fwd: x", body: "<p></p>", quote: { ...quote, kind: "forward" }, remoteContentAllowed: true });
    expect(useComposeStore.getState().quoteRemoteAllowed).toBe(true);
    useComposeStore.getState().reset();

    useComposeStore.getState().openDraft({
      id: "d", to: "", cc: "", bcc: "", subject: "", body: "", quote, inReplyTo: null, references: null, attachments: [],
    });
    expect(useComposeStore.getState().quoteRemoteAllowed).toBe(false);
  });
});
