import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ReadingPane } from "../ReadingPane";

const { ui, auth, useMessage } = vi.hoisted(() => ({
  ui: {
    activeFolder: "INBOX",
    selectedMessageUid: 7,
    effectiveAnimationMode: "off",
    selectMessage: vi.fn(),
  },
  auth: { activeAccountId: "first-account" },
  useMessage: vi.fn(),
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/stores/useUiStore", () => ({
  useUiStore: (selector: (state: typeof ui) => unknown) => selector(ui),
}));
vi.mock("@/stores/useAuthStore", () => ({
  useAuthStore: (selector: (state: typeof auth) => unknown) => selector(auth),
}));
vi.mock("@/hooks/useMessages", () => ({
  useMessage,
  useUpdateFlags: () => ({ mutate: vi.fn() }),
}));
vi.mock("../EmailRenderer", () => ({
  EmailRenderer: ({ theme, blockRemoteResources }: { theme: string; blockRemoteResources: boolean }) => (
    <div data-testid="email-renderer" data-theme={theme} data-remote-blocked={blockRemoteResources} />
  ),
  hasRemoteResources: (html: string | null) => Boolean(html),
}));
vi.mock("../ThreadView", () => ({ ThreadView: () => null }));
vi.mock("../ReadingPane/index", () => ({
  AddressChip: () => null,
  AddressList: () => null,
  AttachmentPreviewer: () => null,
  HeaderSkeleton: () => null,
  BodySkeleton: () => null,
  formatFileSize: () => "",
  humanizeDate: () => "date",
}));

function setMessage(html: string | null = '<img src="https://example.com/pixel.gif">') {
  useMessage.mockReturnValue({
    data: {
      uid: ui.selectedMessageUid,
      folder: ui.activeFolder,
      subject: "A message",
      from_address: "sender@example.com",
      from_name: "Sender",
      to_addresses: [],
      cc_addresses: [],
      date: "2026-03-14T00:00:00Z",
      flags: ["\\Seen"],
      html,
      text: "Plain message text",
      attachments: [],
      thread: [],
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
}

beforeEach(() => {
  ui.activeFolder = "INBOX";
  ui.selectedMessageUid = 7;
  auth.activeAccountId = "first-account";
  setMessage();
});
afterEach(cleanup);

describe("ReadingPane message display choices", () => {
  it("defaults to plain text for messages without HTML", () => {
    setMessage(null);
    render(<ReadingPane />);
    expect(screen.getByText("Plain message text")).toBeTruthy();
    expect(screen.queryByTestId("email-renderer")).toBeNull();
    expect(screen.getByRole("button", { name: "HTML" })).toBeTruthy();
  });

  it.each(["folder", "account", "uid"])("resets body and theme choices when the %s changes", (change) => {
    const { rerender } = render(<ReadingPane />);
    fireEvent.click(screen.getByRole("button", { name: "Plain text" }));
    fireEvent.click(screen.getByRole("button", { name: "Auto theme" }));

    if (change === "folder") ui.activeFolder = "Archive";
    if (change === "account") auth.activeAccountId = "second-account";
    if (change === "uid") ui.selectedMessageUid = 8;
    setMessage();
    rerender(<ReadingPane />);

    expect(screen.getByTestId("email-renderer").getAttribute("data-theme")).toBe("auto");
    expect(screen.getByRole("button", { name: "Plain text" })).toBeTruthy();
  });

  it("preserves manual choices when the same message refreshes and allows toggling back", () => {
    const { rerender } = render(<ReadingPane />);
    fireEvent.click(screen.getByRole("button", { name: "Plain text" }));
    fireEvent.click(screen.getByRole("button", { name: "Auto theme" }));
    setMessage();
    rerender(<ReadingPane />);

    expect(screen.getByText("Plain message text")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Light mode" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "HTML" }));
    expect(screen.getByTestId("email-renderer").getAttribute("data-theme")).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Light mode" }));
    expect(screen.getByTestId("email-renderer").getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Dark mode" }));
    expect(screen.getByTestId("email-renderer").getAttribute("data-theme")).toBe("auto");
  });
});

describe("ReadingPane remote resource consent", () => {
  it.each(["folder", "account", "uid"])("does not reuse consent when the %s changes", (change) => {
    const { rerender } = render(<ReadingPane />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(screen.getByTestId("email-renderer").getAttribute("data-remote-blocked")).toBe("false");

    if (change === "folder") ui.activeFolder = "Archive";
    if (change === "account") auth.activeAccountId = "second-account";
    if (change === "uid") ui.selectedMessageUid = 8;
    setMessage();
    rerender(<ReadingPane />);

    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByTestId("email-renderer").getAttribute("data-remote-blocked")).toBe("true");
  });

  it("remembers consent when returning to the same account and message", () => {
    const { rerender } = render(<ReadingPane />);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    auth.activeAccountId = "second-account";
    rerender(<ReadingPane />);
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();

    auth.activeAccountId = "first-account";
    rerender(<ReadingPane />);
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.getByTestId("email-renderer").getAttribute("data-remote-blocked")).toBe("false");
  });
});
