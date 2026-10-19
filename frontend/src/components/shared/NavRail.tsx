"use client";

import { STORAGE_KEYS, writeStoredPreference } from "@/lib/browser-storage";

import { useTranslation, useLanguageStore } from "@/lib/i18n";

import { useCallback, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Inbox,
  PenLine,
  Users,
  Calendar,
  Settings,
  Moon,
  Sun,
  Keyboard,
  LogOut,
  Volleyball,
} from "lucide-react";
import { Tooltip } from "radix-ui";
import { apiPost } from "@/lib/api";
import { brand } from "@/lib/brand";
import { runThemeSpreadTransition } from "@/lib/motion/theme-spread";
import { cn } from "@/lib/utils";
import { useComposeStore } from "@/stores/useComposeStore";
import { useUiStore } from "@/stores/useUiStore";
import { useAuthStore } from "@/stores/useAuthStore";
import { useAccountUnreadCounts } from "@/hooks/useAccountUnreadCounts";
import { useUpdateDisplayPreferences } from "@/hooks/useDisplayPreferences";
import { ConnectionStatus } from "@/components/shared/ConnectionStatus";
import { useWsStatus } from "@/lib/ws-context";

type NavButtonClickEvent = MouseEvent<Element>;

function NavButton({
  icon,
  label,
  badge,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: (event: NavButtonClickEvent) => void;
}) {
  const { t } = useTranslation();
  const tooltipLabel = disabled ? t("{label} (coming soon)", { label }) : label;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={tooltipLabel}
          aria-current={active ? "page" : undefined}
          className={cn(
            "relative flex size-10 items-center justify-center rounded-lg transition-colors",
            disabled
              ? "cursor-default text-sidebar-foreground/30"
              : "text-sidebar-foreground/70 hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground",
            active && "bg-sidebar-accent text-sidebar-foreground",
          )}
        >
          {icon}
          {badge && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -right-0.5 -top-0.5 flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold leading-none text-primary-foreground ring-2 ring-sidebar tabular-nums"
            >
              {badge}
            </span>
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={8}
          className="rounded-md bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-md border border-border animate-in fade-in-0 zoom-in-95"
        >
          {tooltipLabel}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function useResolvedTheme() {
  const theme = useUiStore((s) => s.theme);
  if (theme === "system") {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

const THEME_STORAGE_KEY = STORAGE_KEYS.theme;

export function NavRail() {
  const { t, language } = useTranslation();
  const setLanguage = useLanguageStore((state) => state.setLanguage);
  const { status: wsStatus, failCount: wsFailCount } = useWsStatus();
  const router = useRouter();
  const viewMode = useUiStore((s) => s.viewMode);
  const setViewMode = useUiStore((s) => s.setViewMode);
  const setActiveFolder = useUiStore((s) => s.setActiveFolder);
  const clearSearch = useUiStore((s) => s.clearSearch);
  const setTheme = useUiStore((s) => s.setTheme);
  const effectiveAnimationMode = useUiStore((s) => s.effectiveAnimationMode);
  const updatePrefs = useUpdateDisplayPreferences();
  const resolvedTheme = useResolvedTheme();
  const accounts = useAuthStore((s) => s.accounts);
  const unreadCounts = useAccountUnreadCounts();
  const accountCounts = accounts.map((account) => unreadCounts[account.id]);
  const totalUnreadCount = accountCounts.reduce(
    (total, unread) => total + (unread?.isError ? 0 : unread?.count ?? 0),
    0,
  );
  const hasUnknownCounts = accountCounts.some((unread) => unread?.count == null || unread.isError);
  const unreadBadge = totalUnreadCount > 0
    ? totalUnreadCount > 99 ? "99+" : `${totalUnreadCount}${hasUnknownCounts ? "+" : ""}`
    : undefined;
  const mailLabel = totalUnreadCount > 0
    ? t(hasUnknownCounts
      ? totalUnreadCount === 1 ? "Mail — at least {count} unread message in all inboxes" : "Mail — at least {count} unread messages in all inboxes"
      : totalUnreadCount === 1 ? "Mail — {count} unread message in all inboxes" : "Mail — {count} unread messages in all inboxes", { count: totalUnreadCount })
    : t("Mail");

  const toggleTheme = useCallback((event: NavButtonClickEvent) => {
    const next = resolvedTheme === "dark" ? "light" : "dark";
    runThemeSpreadTransition({
      mode: effectiveAnimationMode,
      trigger: "explicit",
      origin: { x: event.clientX, y: event.clientY },
      applyTheme: () => setTheme(next),
      nextTheme: next,
    });
    writeStoredPreference(THEME_STORAGE_KEY, next);
    updatePrefs.mutate({ theme: next });
  }, [effectiveAnimationMode, resolvedTheme, setTheme, updatePrefs]);

  const handleLogout = useCallback(async () => {
    try {
      await apiPost("/auth/logout", {});
    } catch {
      // Even if the API call fails, redirect to login
    }
    router.replace("/");
  }, [router]);

  return (
    <Tooltip.Provider delayDuration={400}>
      <nav aria-label={t("Main navigation")} className="relative flex h-full w-14 shrink-0 flex-col items-center border-r border-border bg-background py-2">
        {/* Brand */}
        <div
          className="mb-4 flex size-10 items-center justify-center"
          role="img"
          aria-label={brand.appName}
          title={brand.appName}
        >
          <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Volleyball className="size-6" />
          </span>
        </div>

        {/* Top actions */}
        <div className="flex flex-col items-center gap-1">
          <NavButton
            icon={<PenLine className="size-5" />}
            label={t("Compose")}
            onClick={() => useComposeStore.getState().openCompose()}
          />
          <NavButton
            icon={<Inbox className="size-5" />}
            label={mailLabel}
            badge={unreadBadge}
            active={viewMode === "mail"}
            onClick={() => {
              clearSearch();
              setActiveFolder("INBOX");
              setViewMode("mail");
            }}
          />
          <NavButton
            icon={<Users className="size-5" />}
            label={t("Contacts")}
            active={viewMode === "contacts"}
            onClick={() => setViewMode(viewMode === "contacts" ? "mail" : "contacts")}
          />
          <NavButton
            icon={<Calendar className="size-5" />}
            label={t("Calendar")}
            active={viewMode === "calendar"}
            onClick={() => setViewMode(viewMode === "calendar" ? "mail" : "calendar")}
          />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        <ConnectionStatus status={wsStatus} failCount={wsFailCount} />

        <NavButton
          icon={<span className="text-[11px] font-semibold">{language.toUpperCase()}</span>}
          label={t(language === "en" ? "Switch to French" : "Switch to English")}
          onClick={() => setLanguage(language === "en" ? "fr" : "en")}
        />

        {/* Bottom actions */}
        <div className="flex flex-col items-center gap-1">
          <NavButton
            icon={<Settings className="size-5" />}
            label={t("Settings")}
            active={viewMode === "settings"}
            onClick={() => setViewMode(viewMode === "settings" ? "mail" : "settings")}
          />
          <NavButton
            icon={
              resolvedTheme === "dark" ? (
                <Sun className="size-5" />
              ) : (
                <Moon className="size-5" />
              )
            }
            label={t(resolvedTheme === "dark" ? "Light mode" : "Dark mode")}
            onClick={toggleTheme}
          />
          <NavButton
            icon={<Keyboard className="size-5" />}
            label={t("Keyboard shortcuts")}
            onClick={() => useUiStore.getState().setShortcutsOpen(true)}
          />
          <NavButton
            icon={<LogOut className="size-5" />}
            label={t("Logout")}
            onClick={handleLogout}
          />
        </div>

      </nav>
    </Tooltip.Provider>
  );
}
