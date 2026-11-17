import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/useAuthStore";
import { useComposeStore } from "@/stores/useComposeStore";
import { useUiStore } from "@/stores/useUiStore";
import { MessageReplyActions } from "../MessageReplyActions";
import { MessageActionBar } from "../MessageActionBar";
import type { MessageDetail } from "@/types/message";

const { message } = vi.hoisted(() => ({ message: { data: undefined as MessageDetail | undefined } }));
vi.mock("@/hooks/useMessages", () => ({
  useMessage: () => message,
  useUpdateFlags: () => ({ mutate: vi.fn() }),
  useMoveMessage: () => ({ mutate: vi.fn() }),
  useDeleteMessage: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/useIdentities", () => ({ useIdentities: () => ({ data: [] }) }));
vi.mock("@/hooks/useFolders", () => ({ useFolders: () => ({ data: { folders: [] } }) }));
vi.mock("../TagPicker", () => ({ TagPicker: () => null }));
vi.mock("../MoveToFolderMenu", () => ({ MoveToFolderMenu: () => null }));

beforeEach(() => {
  useUiStore.setState({ activeFolder: "INBOX", selectedMessageUid: 7, effectiveAnimationMode: "off", collapseQuotes: false });
  useAuthStore.setState({ activeAccountId: "me", accounts: [{ id: "me", email: "me@example.com", imapHost: "", smtpHost: "" }] });
  useComposeStore.getState().reset();
  message.data = {
    uid: 7, folder: "INBOX", subject: "Training", from_address: "coach@example.com", from_name: "Coach",
    to_addresses: [{ name: null, address: "me@example.com" }], cc_addresses: [],
    date: "2026-10-14T12:00:00Z", flags: ["\\Seen"], html: null, text: "See you Tuesday",
    raw_headers: "Message-ID: <training@example.com>\r\n", attachments: [], thread: [],
  };
});

describe.each([false, true])("message actions (labeled=%s)", (labeled) => {
  it("opens a reply with the sender and threading information", () => {
    render(<MessageReplyActions labeled={labeled} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(useComposeStore.getState()).toMatchObject({ isOpen: true, to: "coach@example.com", subject: "Re: Training", inReplyTo: "<training@example.com>" });
  });

  it("replies to all other participants", () => {
    message.data!.cc_addresses = [{ name: null, address: "team@example.com" }];
    render(<MessageReplyActions labeled={labeled} />);
    fireEvent.click(screen.getByRole("button", { name: "Reply all" }));
    expect(useComposeStore.getState()).toMatchObject({ to: "coach@example.com", cc: "team@example.com" });
  });

  it("forwards with an empty recipient and the original content shown below the editor", () => {
    render(<MessageReplyActions labeled={labeled} />);
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(useComposeStore.getState()).toMatchObject({ isOpen: true, to: "", subject: "Fwd: Training", body: "", quoteKind: "forward", showQuoted: true });
    expect(useComposeStore.getState().quotedText).toContain("See you Tuesday");
    expect(useComposeStore.getState().quotedHtml).toContain("See you Tuesday");
  });
});

it.each([
  [false, true],
  [true, false],
])("starts the reply quote expanded unless the preference collapses it (collapse=%s)", (collapseQuotes, showQuoted) => {
  useUiStore.setState({ collapseQuotes });
  render(<MessageReplyActions labeled />);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(useComposeStore.getState()).toMatchObject({ quoteKind: "reply", showQuoted });
});

it("always shows the forwarded message, even when quotes are collapsed", () => {
  useUiStore.setState({ collapseQuotes: true });
  render(<MessageReplyActions labeled />);
  fireEvent.click(screen.getByRole("button", { name: "Forward" }));
  expect(useComposeStore.getState()).toMatchObject({ quoteKind: "forward", showQuoted: true });
});

it("opens a reply with an empty editor and the quote kept separately", () => {
  message.data!.html = '<div dir="ltr">Hi</div><div class="gmail_quote"><blockquote class="gmail_quote" style="border-left:1px solid #ccc"><div>Older</div></blockquote></div>';
  render(<MessageReplyActions labeled />);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const state = useComposeStore.getState();
  expect(state).toMatchObject({ body: "<p></p>", isHtml: true, quoteKind: "reply", showQuoted: true });
  expect(state.quotedHtml).toMatch(/^<div class="peps_quote_attr">On .+, Coach &lt;coach@example.com&gt; wrote:<\/div><blockquote type="cite"/);
  expect(state.quotedHtml).toContain(message.data!.html);
  expect(state.quotedText).toMatch(/^On .+, Coach <coach@example.com> wrote:\n> See you Tuesday$/);
});

it("shows only Reply and Forward in the footer for direct conversations", () => {
  render(<MessageReplyActions labeled />);
  expect(screen.getAllByRole("button")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Reply all" })).toBeNull();
});

it("returns to the message list without clearing the current search or folder", () => {
  useUiStore.setState({ searchActive: true, searchQuery: "from:coach" });
  render(<MessageActionBar showBack />);
  fireEvent.click(screen.getByRole("button", { name: "Back to messages" }));
  expect(useUiStore.getState()).toMatchObject({ selectedMessageUid: null, activeFolder: "INBOX", searchActive: true, searchQuery: "from:coach" });
});

it("keeps reply actions out of the top toolbar", () => {
  render(<MessageActionBar showBack />);
  expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reply all" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Forward" })).toBeNull();
});

it("drops remote images from the quoted HTML unless remote content was allowed", () => {
  message.data!.html = '<p>Hello</p><img src="https://tracker.example/p.gif" alt="Logo"><img src="data:image/png;base64,AAAA">';
  const { unmount } = render(<MessageReplyActions labeled />);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const blocked = useComposeStore.getState().quotedHtml;
  expect(blocked).not.toContain("tracker.example");
  expect(blocked).toContain("Logo");
  expect(blocked).toContain("data:image/png;base64,AAAA");
  unmount();

  useComposeStore.getState().reset();
  render(<MessageReplyActions labeled remoteContentAllowed />);
  fireEvent.click(screen.getByRole("button", { name: "Forward" }));
  expect(useComposeStore.getState().quotedHtml).toContain("https://tracker.example/p.gif");
});
