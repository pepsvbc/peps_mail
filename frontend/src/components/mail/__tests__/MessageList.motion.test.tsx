import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type Key, type ReactNode } from "react";

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const { useRef, useEffect, useState } = React;

  function getKeyedChildren(children: ReactNode) {
    return Children.toArray(children).filter(
      (child): child is React.ReactElement => isValidElement(child) && child.key != null,
    );
  }

  function AnimatePresence({ children }: { children: ReactNode }) {
    const prevChildrenByKeyRef = useRef(new Map<Key, React.ReactElement>());
    const prevKeysRef = useRef(new Set<Key>());
    const [displayChildren, setDisplayChildren] = useState<React.ReactElement[]>([]);

    useEffect(() => {
      const keyedChildren = getKeyedChildren(children);
      const currentKeys = new Set(keyedChildren.map((child) => child.key as Key));

      const exitingChildren = Array.from(prevKeysRef.current)
        .filter((key) => !currentKeys.has(key))
        .map((key) => prevChildrenByKeyRef.current.get(key))
        .filter((child): child is React.ReactElement => child != null);

      const nextChildren = [...keyedChildren, ...exitingChildren];
      setDisplayChildren(nextChildren);

      for (const child of keyedChildren) {
        prevChildrenByKeyRef.current.set(child.key as Key, child);
      }
      prevKeysRef.current = currentKeys;
    }, [children]);

    return <>{displayChildren}</>;
  }

  return {
    AnimatePresence,
    motion: {
      div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    },
  };
});

const { mockUiState, mockUseMessages, mockOpenDraft } = vi.hoisted(() => ({
  mockUiState: {
    activeFolder: "INBOX",
    unreadOnly: false,
    activeTagId: null as string | null,
    density: "comfortable" as "compact" | "standard" | "comfortable",
    selectedMessageUid: 1 as number | null,
    selectedMessageUids: [] as number[],
    bulkSelectMode: false,
    keyboardNav: false,
    readingPaneVisible: true,
    effectiveAnimationMode: "medium" as "rich" | "medium" | "subtle" | "off",
    selectMessage: vi.fn(),
    toggleBulkSelect: vi.fn(),
    selectAllMessages: vi.fn(),
    clearBulkSelection: vi.fn(),
    setReadingPaneVisible: vi.fn(),
    setKeyboardNav: vi.fn(),
  },
  mockUseMessages: vi.fn(),
  mockOpenDraft: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => {
    const size = estimateSize();
    return {
      getVirtualItems: () =>
        Array.from({ length: count }, (_, index) => ({
          index,
          start: index * size,
          size,
        })),
      getTotalSize: () => count * size,
    };
  },
}));

vi.mock("@/stores/useUiStore", () => {
  const useUiStore = (selector: (state: typeof mockUiState) => unknown) => selector(mockUiState);
  useUiStore.getState = () => mockUiState;
  return { useUiStore };
});

vi.mock("@/hooks/useTags", () => ({
  useTags: () => ({ data: { tags: [] } }),
  useTagMessages: () => ({ data: { messages: [], total_count: 0 }, isLoading: false, isFetching: false, isError: false, refetch: vi.fn() }),
}));

vi.mock("@/hooks/useOpenDraft", () => ({ useOpenDraft: () => ({ openDraft: mockOpenDraft, isPending: false }) }));
vi.mock("@/hooks/useFolders", () => ({ useFolders: () => ({ data: { folders: [] } }) }));

vi.mock("@/hooks/useCompose", () => ({
  useListDrafts: () => ({ data: { drafts: [] } }),
  useGetDraft: () => ({ data: null }),
  useDeleteDraft: () => ({ mutate: vi.fn() }),
}));

vi.mock("@/stores/useComposeStore", () => ({
  useComposeStore: () => ({
    openDraft: vi.fn(),
    isOpen: false,
  }),
}));

vi.mock("../BulkActionBar", () => ({
  BulkActionBar: () => <div data-testid="bulk-action-bar" />,
}));

const mockUpdateFlags = vi.fn();

vi.mock("@/hooks/useMessages", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useMessages")>("@/hooks/useMessages");
  return {
    ...actual,
    useMessages: mockUseMessages,
    useUpdateFlags: () => ({ mutate: mockUpdateFlags }),
  };
});

import { MessageList } from "../MessageList";
import { MessageListItem } from "../MessageListItem";

function buildMessage(uid: number) {
  return {
    uid,
    folder: "INBOX",
    message_id: `<m-${uid}@example.com>`,
    in_reply_to: null,
    subject: `Subject ${uid}`,
    from_address: "sender@example.com",
    from_name: `Sender ${uid}`,
    to_addresses: "receiver@example.com",
    cc_addresses: "",
    date: "2026-03-14T00:00:00Z",
    flags: "",
    size: 1024,
    has_attachments: false,
    snippet: "Snippet",
    reaction: null,
    tags: [],
  };
}

function setMessages(uids: number[], readUids: number[] = [], hasNextPage = false) {
  const messages = uids.map((uid) => ({ ...buildMessage(uid), flags: readUids.includes(uid) ? "\\Seen" : "" }));
  const fetchNextPage = vi.fn();
  mockUseMessages.mockReturnValue({
    data: {
      pages: [{ messages, total_count: messages.length, syncing: false }],
    },
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage: false,
  });
  return fetchNextPage;
}

describe("MessageList and MessageListItem motion transitions", () => {
  beforeEach(() => {
    mockUiState.unreadOnly = false;
    mockUiState.density = "comfortable";
    mockUiState.activeFolder = "INBOX";
    mockOpenDraft.mockClear();
    mockUiState.selectMessage.mockClear();
  });

  it("opens server drafts in the composer instead of the reading pane", () => {
    mockUiState.activeFolder = "Drafts";
    mockUiState.effectiveAnimationMode = "off";
    setMessages([7]);
    mockUseMessages().data.pages[0].messages[0].folder = "Drafts";
    render(<MessageList />);
    fireEvent.click(screen.getByText("Subject 7"));
    expect(mockOpenDraft).toHaveBeenCalledWith({ folder: "Drafts", uid: 7 });
    expect(mockUiState.selectMessage).not.toHaveBeenCalled();
  });

  it("shows sender and subject without the preview in Standard density", () => {
    mockUiState.density = "standard";
    mockUiState.effectiveAnimationMode = "off";
    setMessages([1]);
    render(<MessageList />);
    expect(screen.getByText("Sender 1")).toBeTruthy();
    expect(screen.getByText("Subject 1")).toBeTruthy();
    expect(screen.queryByText("Snippet")).toBeNull();
  });

  it("filters read messages from the unread list", () => {
    mockUiState.unreadOnly = true;
    mockUiState.effectiveAnimationMode = "off";
    setMessages([1, 2], [1]);
    render(<MessageList />);
    expect(screen.queryByText("Subject 1")).toBeNull();
    expect(screen.getByText("Subject 2")).toBeTruthy();
  });

  it("continues loading unread messages when the first page contains only read mail", () => {
    mockUiState.unreadOnly = true;
    const nextPage = setMessages([1, 2], [1, 2], true);
    render(<MessageList />);
    expect(nextPage).toHaveBeenCalled();
    expect(screen.queryByText("No unread messages")).toBeNull();
  });

  it("animates message rows enter/exit in non-off modes", () => {
    mockUiState.effectiveAnimationMode = "medium";
    setMessages([1, 2]);

    const { rerender } = render(<MessageList />);

    expect(screen.getAllByTestId("message-list-row-transition").length).toBe(2);

    setMessages([1]);
    rerender(<MessageList />);

    expect(screen.getByText("Subject 1")).toBeTruthy();
    expect(screen.queryAllByTestId("message-list-row-transition").length).toBeGreaterThanOrEqual(1);
  });

  it("applies bounded stagger only to newly changed visible rows", () => {
    mockUiState.effectiveAnimationMode = "rich";
    setMessages([1, 2, 3]);

    const { rerender } = render(<MessageList />);
    expect(screen.getAllByTestId("message-list-row-transition").length).toBe(3);

    setMessages([1, 2, 3, 4]);
    rerender(<MessageList />);

    const rows = screen.getAllByTestId("message-list-row-transition");
    const changedRows = rows.filter((row) => row.getAttribute("data-row-changed") === "true");
    expect(changedRows.length).toBe(1);
    expect(changedRows[0]?.getAttribute("data-row-uid")).toBe("4");

    const delay = Number(changedRows[0]?.getAttribute("data-row-stagger-delay") ?? "0");
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(0.2);
  });

  it("renders static rows without motion wrappers when mode is off", () => {
    mockUiState.effectiveAnimationMode = "off";
    setMessages([1]);

    render(<MessageList />);

    expect(screen.queryByTestId("message-list-row-transition")).toBeNull();
    expect(screen.getByText("Subject 1")).toBeTruthy();
  });

  it("animates selected state transitions for medium and rich modes", () => {
    const message = buildMessage(42);

    mockUiState.effectiveAnimationMode = "medium";
    const { rerender } = render(
      <MessageListItem
        message={message}
        isSelected
        density="comfortable"
        onClick={vi.fn()}
        bulkSelectMode={false}
        isBulkSelected={false}
        onBulkToggle={vi.fn()}
        effectiveAnimationMode="medium"
      />,
    );
    expect(screen.getByTestId("message-list-item-selection-transition")).toBeTruthy();

    mockUiState.effectiveAnimationMode = "rich";
    rerender(
      <MessageListItem
        message={message}
        isSelected
        density="comfortable"
        onClick={vi.fn()}
        bulkSelectMode={false}
        isBulkSelected={false}
        onBulkToggle={vi.fn()}
        effectiveAnimationMode="rich"
      />,
    );
    expect(screen.getByTestId("message-list-item-selection-transition")).toBeTruthy();
  });

  it("uses transform/opacity-only transition declarations", () => {
    mockUiState.effectiveAnimationMode = "medium";
    setMessages([1]);

    render(<MessageList />);

    const row = screen.getByTestId("message-list-row-transition");
    const serialized = row.getAttribute("data-motion-props") ?? "";

    for (const forbidden of ["width", "height", "top", "left"]) {
      expect(serialized.includes(forbidden)).toBe(false);
    }
  });

  it.each([["compact", 44], ["standard", 72], ["comfortable", 96]] as const)("keeps %s virtualization rows correctly spaced", (density, height) => {
    mockUiState.density = density;
    mockUiState.effectiveAnimationMode = "medium";
    setMessages([1, 2]);

    render(<MessageList />);

    const rows = screen.getAllByTestId("message-list-row-transition");
    const secondRow = rows[1];

    expect(secondRow?.style.top).toBe(`${height}px`);
    expect(secondRow?.style.transform).toBe("");
  });
});

it("does not leave exiting inbox rows visible after switching to Drafts", () => {
  mockUiState.activeFolder = "INBOX";
  mockUiState.effectiveAnimationMode = "medium";
  setMessages([1]);
  const { rerender } = render(<MessageList />);
  expect(screen.getByText("Subject 1")).toBeTruthy();
  mockUiState.activeFolder = "Drafts";
  setMessages([2]);
  mockUseMessages().data.pages[0].messages[0].folder = "Drafts";
  rerender(<MessageList />);
  expect(screen.queryByText("Subject 1")).toBeNull();
  expect(screen.getByText("Subject 2")).toBeTruthy();
});

it("never renders cached inbox rows under Drafts, including colliding UIDs", () => {
  mockUiState.activeFolder = "Drafts";
  mockUiState.effectiveAnimationMode = "off";
  setMessages([7]);
  const page = mockUseMessages().data.pages[0];
  page.messages.push({ ...buildMessage(7), folder: "Drafts", subject: "Unsent message", flags: "\\Draft,\\Seen", to_addresses: JSON.stringify([{ name: null, address: "receiver@example.com" }]) });
  render(<MessageList />);
  expect(screen.queryByText("Subject 7")).toBeNull();
  expect(screen.getByText("Unsent message")).toBeTruthy();
  expect(screen.getByText("Draft")).toBeTruthy();
  expect(screen.getByText("receiver@example.com")).toBeTruthy();
});
