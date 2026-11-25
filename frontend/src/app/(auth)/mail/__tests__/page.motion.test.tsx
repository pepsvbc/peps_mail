import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mockUiState } = vi.hoisted(() => ({
  mockUiState: {
    viewMode: "mail" as "mail" | "settings" | "lists" | "users",
    effectiveAnimationMode: "medium" as "rich" | "medium" | "subtle" | "off",
  },
}));

vi.mock("@/stores/useUiStore", () => ({
  useUiStore: (selector: (state: typeof mockUiState) => unknown) => selector(mockUiState),
}));

vi.mock("@/hooks/useKeyboardShortcuts", () => ({
  useKeyboardShortcuts: vi.fn(),
}));

vi.mock("@/hooks/useWebSocket", () => ({
  useWebSocket: vi.fn(() => ({ status: "connected", failCount: 0 })),
}));

vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: vi.fn(() => ({
    showBanner: false,
    requestPermission: vi.fn(),
    dismissBanner: vi.fn(),
    handleEvent: vi.fn(),
  })),
}));

vi.mock("@/components/shared/ThreePanelLayout", () => ({
  ThreePanelLayout: vi.fn(() => <div data-testid="mail-layout" />),
}));

vi.mock("@/components/shared/NavRail", () => ({
  NavRail: vi.fn(() => <div data-testid="nav-rail" />),
}));

vi.mock("@/components/mail/FolderTree", () => ({
  FolderTree: vi.fn(() => <div data-testid="folder-tree" />),
}));

vi.mock("@/components/mail/MessageList", () => ({
  MessageList: vi.fn(() => <div data-testid="message-list" />),
}));

vi.mock("@/components/mail/ReadingPane", () => ({
  ReadingPane: vi.fn(() => <div data-testid="reading-pane" />),
}));

vi.mock("@/components/lists/DistributionListsPage", () => ({
  DistributionListsPage: vi.fn(() => <div data-testid="lists-page" />),
}));

vi.mock("@/integrations/franklymail/AdminPage", () => ({ AdminPage: () => <div data-testid="users-page" /> }));

vi.mock("@/components/settings/SettingsPanel", () => ({
  SettingsPanel: vi.fn(() => <div data-testid="settings-panel" />),
}));

vi.mock("@/components/shared/NotificationBanner", () => ({
  NotificationBanner: vi.fn(() => <div data-testid="notification-banner" />),
}));

vi.mock("@/components/shared/KeyboardShortcuts", () => ({
  KeyboardShortcuts: vi.fn(() => <div data-testid="keyboard-shortcuts" />),
}));

vi.mock("@/components/shared/CommandPalette", () => ({
  CommandPalette: vi.fn(() => <div data-testid="command-palette" />),
}));

vi.mock("@/components/PreferencesLoader", () => ({
  PreferencesLoader: vi.fn(() => <div data-testid="preferences-loader" />),
}));

import MailPage from "../page";

describe("Mail page motion transitions", () => {
  it("uses animated wrappers for all views in non-off modes", () => {
    const views: Array<"mail" | "settings" | "lists" | "users"> = ["mail", "settings", "lists", "users"];
    const modes: Array<"rich" | "medium" | "subtle"> = ["rich", "medium", "subtle"];

    for (const mode of modes) {
      mockUiState.effectiveAnimationMode = mode;

      for (const view of views) {
        mockUiState.viewMode = view;
        const { unmount } = render(<MailPage />);
        expect(screen.getByTestId(`mail-view-transition-${view}`)).toBeTruthy();
        unmount();
      }
    }
  });

  it("uses a static non-animated path in off mode", () => {
    const views: Array<"mail" | "settings" | "lists" | "users"> = ["mail", "settings", "lists", "users"];

    mockUiState.effectiveAnimationMode = "off";

    for (const view of views) {
      mockUiState.viewMode = view;
      const { unmount } = render(<MailPage />);
      expect(screen.getByTestId(`mail-view-static-${view}`)).toBeTruthy();
      expect(screen.queryByTestId(`mail-view-transition-${view}`)).toBeNull();
      unmount();
    }
  });

  it("falls back to the mail layout for retired view modes", () => {
    mockUiState.effectiveAnimationMode = "off";

    for (const retired of ["contacts", "calendar"]) {
      mockUiState.viewMode = retired as "mail";
      const { unmount } = render(<MailPage />);
      expect(screen.getByTestId("mail-layout")).toBeTruthy();
      expect(screen.queryByTestId("settings-panel")).toBeNull();
      unmount();
    }
  });
});
