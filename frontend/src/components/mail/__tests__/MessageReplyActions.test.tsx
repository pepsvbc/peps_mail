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
  useUiStore.setState({ activeFolder: "INBOX", selectedMessageUid: 7, effectiveAnimationMode: "off" });
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

  it("forwards with an empty recipient and the original content", () => {
    render(<MessageReplyActions labeled={labeled} />);
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(useComposeStore.getState()).toMatchObject({ isOpen: true, to: "", subject: "Fwd: Training" });
    expect(useComposeStore.getState().body).toContain("See you Tuesday");
  });
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
