"use client";

import { useTranslation } from "@/lib/i18n";

import { useAuthStore } from "@/stores/useAuthStore";
import { useUiStore } from "@/stores/useUiStore";
import { cn } from "@/lib/utils";
import { Plus, ChevronRight, LogOut, X, Check } from "lucide-react";
import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiPost } from "@/lib/api";
import { useRouter } from "next/navigation";
import { AddAccountModal } from "./AddAccountModal";
import { createScaleFadeVariants } from "@/lib/motion/variants";
import { AnimatedDiv } from "@/lib/motion/AnimatedDiv";
import { useAccountUnreadCounts } from "@/hooks/useAccountUnreadCounts";

export function AccountSwitcher() {
  const { t } = useTranslation();
  const accounts = useAuthStore((s) => s.accounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const setActiveAccount = useAuthStore((s) => s.setActiveAccount);
  const removeAccount = useAuthStore((s) => s.removeAccount);
  const setAccounts = useAuthStore((s) => s.setAccounts);
  const queryClient = useQueryClient();
  const unreadCounts = useAccountUnreadCounts();
  const router = useRouter();
  const [showAddModal, setShowAddModal] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState<string | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const effectiveAnimationMode = useUiStore((s) => s.effectiveAnimationMode);
  const dropdownMotionProps = useMemo(() => createScaleFadeVariants(effectiveAnimationMode), [effectiveAnimationMode]);
  const canPortal = typeof document !== "undefined";

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.top,
        left: rect.right + 16,
      });
    }
  }, [isOpen]);

  if (accounts.length === 0) {
    return null;
  }

  const activeAccount = accounts.find((a) => a.id === activeAccountId);
  const otherAccounts = accounts.filter((account) => account.id !== activeAccountId);
  const otherCounts = otherAccounts.map((account) => unreadCounts[account.id]);
  const otherUnreadCount = otherCounts.reduce(
    (total, unread) => total + (unread?.isError ? 0 : unread?.count ?? 0),
    0,
  );
  const otherCountsUnknown = otherCounts.some((unread) => unread?.count == null || unread.isError);
  const otherCountsLoading = otherCounts.some((unread) => !unread || unread.isLoading);
  const otherUnreadNumber = otherCountsUnknown && otherUnreadCount === 0
    ? otherCountsLoading ? "…" : "—"
    : `${otherUnreadCount}${otherCountsUnknown ? "+" : ""}`;
  const [beforeCount, afterCount] = otherCountsUnknown && otherUnreadCount === 0
    ? ["", ""]
    : t(otherUnreadCount === 1 && !otherCountsUnknown ? "{count} unread message" : "{count} unread").split("{count}");

  const handleSwitchAccount = async (accountId: string) => {
    if (accountId === activeAccountId) {
      setIsOpen(false);
      return;
    }

    setIsSwitching(true);
    setIsOpen(false);

    await new Promise((r) => setTimeout(r, 150));

    setActiveAccount(accountId);
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "account-unread" });

    await new Promise((r) => setTimeout(r, 100));
    setIsSwitching(false);
  };

  const handleLogoutAccount = async (accountId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setLoggingOut(accountId);
    try {
      await apiDelete(`/auth/accounts/${accountId}`);
      removeAccount(accountId);
      queryClient.removeQueries({ queryKey: ["account-unread", accountId], exact: true });
      if (accountId === activeAccountId) {
        queryClient.clear();
      }
    } catch (err) {
      console.error("Failed to logout account:", err);
    } finally {
      setLoggingOut(null);
    }
  };

  const handleLogoutAll = async () => {
    setLoggingOut("all");
    try {
      await apiPost("/auth/logout", {});
      setAccounts([]);
      queryClient.clear();
      router.push("/");
    } catch (err) {
      console.error("Failed to logout all accounts:", err);
    } finally {
      setLoggingOut(null);
    }
  };

  return (
    <>
      {isSwitching && (
        <div className="fixed inset-0 bg-background z-[100] flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="size-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-muted-foreground">{t("Switching account...")}</span>
          </div>
        </div>
      )}

      <div>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm transition-colors",
            "border border-border bg-background text-foreground",
            "hover:bg-muted"
          )}
        >
          <div className="size-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
            {activeAccount?.email[0]?.toUpperCase() ?? "?"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="truncate">{activeAccount?.email}</div>
            {otherAccounts.length > 0 && (
              <div
                className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"
                title={t("Unread messages in other inboxes")}
              >
                {beforeCount}
                <span
                  className={cn(
                    "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                    otherUnreadCount > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                  )}
                >
                  {otherUnreadNumber}
                </span>
                {afterCount}
              </div>
            )}
          </div>
          <ChevronRight
            className={cn(
              "size-4 shrink-0 transition-transform",
              isOpen && "rotate-90"
            )}
          />
        </button>

        {canPortal &&
          createPortal(
            <AnimatePresence>
              {isOpen ? (
                <AnimatedDiv
                  ref={dropdownRef}
                  data-testid="account-switcher-dropdown-transition"
                  variants={dropdownMotionProps}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="fixed w-72 bg-popover border border-border rounded-lg shadow-xl z-50 overflow-hidden"
                  style={{
                    top: dropdownPosition.top,
                    left: dropdownPosition.left,
                  }}
                >
              <div className="py-1">
                {accounts.map((account) => {
                  const isActive = account.id === activeAccountId;
                  const isLoggingOut = loggingOut === account.id;
                  const unread = unreadCounts[account.id];
                  const unreadCount = unread?.isError ? undefined : unread?.count;
                  const unreadLabel = unreadCount != null
                    ? t(unreadCount === 1 ? "{count} unread message in Inbox" : "{count} unread messages in Inbox", { count: unreadCount })
                    : unread?.isError ? t("Unread Inbox count unavailable") : t("Checking unread Inbox count");

                  return (
                    <div
                      key={account.id}
                      role="button"
                      tabIndex={0}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors",
                        "hover:bg-accent focus:bg-accent focus:outline-none",
                        isActive && "bg-accent/50"
                      )}
                      onClick={() => handleSwitchAccount(account.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          handleSwitchAccount(account.id);
                        }
                      }}
                    >
                      <div className={cn(
                        "size-8 rounded-full flex items-center justify-center text-sm font-medium shrink-0",
                        isActive ? "bg-primary text-primary-foreground" : "bg-muted"
                      )}>
                        {account.email[0]?.toUpperCase() ?? "?"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={cn(
                          "truncate text-sm font-medium",
                          isActive ? "text-foreground" : "text-foreground/80"
                        )}>
                          {account.email}
                        </div>
                      </div>
                      <span
                        aria-label={unreadLabel}
                        title={unreadLabel}
                        className={cn(
                          "inline-flex min-w-6 shrink-0 items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
                          unreadCount != null && unreadCount > 0
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {unreadCount ?? (unread?.isError ? "—" : "…")}
                      </span>
                      <div className="shrink-0 w-8 flex items-center justify-center">
                        {isActive && (
                          <Check className="size-4 text-primary" />
                        )}
                        {!isActive && (
                          <button
                            type="button"
                            onClick={(e) => handleLogoutAccount(account.id, e)}
                            disabled={isLoggingOut}
                            className={cn(
                              "p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors",
                              isLoggingOut && "opacity-50 cursor-not-allowed"
                            )}
                            title={t("Sign out this account")}
                          >
                            <X className="size-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-border">
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    setShowAddModal(true);
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  <div className="size-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <Plus className="size-4" />
                  </div>
                  <span className="font-medium">{t("Add account")}</span>
                </button>

                {accounts.length > 1 && (
                  <button
                    type="button"
                    onClick={handleLogoutAll}
                    disabled={loggingOut === "all"}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
                      loggingOut === "all" && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <div className="size-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <LogOut className="size-4" />
                    </div>
                    <span className="font-medium">{t("Sign out all accounts")}</span>
                  </button>
                )}
              </div>
                </AnimatedDiv>
              ) : null}
            </AnimatePresence>,
            document.body
          )}

        <AddAccountModal open={showAddModal} onClose={() => setShowAddModal(false)} />
      </div>
    </>
  );
}
