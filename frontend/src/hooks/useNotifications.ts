"use client";

import { STORAGE_KEYS, readStoredPreference, writeStoredPreference } from "@/lib/browser-storage";

import { translate as t } from "@/lib/i18n";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuthStore } from "@/stores/useAuthStore";
import { useUiStore } from "@/stores/useUiStore";
import { useNotificationPreferences } from "./useNotificationPreferences";
import type { MailEvent } from "./useWebSocket";

export function useNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return "denied";
    }
    return Notification.permission;
  });
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return readStoredPreference(STORAGE_KEYS.notificationBannerDismissed) === "true";
  });

  const { data: prefs } = useNotificationPreferences();
  const activeAccount = useAuthStore((s) => s.activeAccount());
  const setActiveFolder = useUiStore((s) => s.setActiveFolder);

  const showBanner = permission === "default" && !bannerDismissed;

  const requestPermission = useCallback(async () => {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setPermission(result);
  }, []);

  const dismissBanner = useCallback(() => {
    setBannerDismissed(true);
    writeStoredPreference(STORAGE_KEYS.notificationBannerDismissed, "true");
  }, []);

  // Re-check permission on visibility change
  useEffect(() => {
    if (!("Notification" in window)) return;
    const check = () => setPermission(Notification.permission);
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, []);

  const handleEvent = useCallback(
    (event: MailEvent) => {
      if (event.type !== "NewMessages") return;
      if (!prefs?.enabled) return;

      const folder = event.data?.folder;
      if (!folder) return;
      if (!prefs.folders.includes(folder)) return;

      const count = event.data?.count ?? 0;
      const sender = event.data?.latest_sender;
      const subject = event.data?.latest_subject;

      // Title: user's own email (the mailbox) or fallback.
      const title = activeAccount?.email ?? t("New email");

      // Body lines: sender + subject when available.
      const bodyLines: string[] = [];
      if (count > 1) {
        bodyLines.push(t("{count} new emails", { count }));
        if (sender) bodyLines.push(t("Email from: {sender}", { sender }));
        if (subject) bodyLines.push(t("Subject: {subject}", { subject }));
      } else {
        if (sender) bodyLines.push(t("Email from: {sender}", { sender }));
        if (subject) bodyLines.push(t("Subject: {subject}", { subject }));
        if (bodyLines.length === 0) bodyLines.push(t("New message received"));
      }
      const body = bodyLines.join("\n");

      if (document.hidden || !document.hasFocus()) {
        // Tab is hidden or window is unfocused — show OS notification.
        if (permission === "granted") {
          const notification = new Notification(title, {
            body,
            tag: `peps-mail-${folder}`,
            icon: "/notification-icon.svg",
          });

          notification.onclick = () => {
            window.focus();
            setActiveFolder(folder);
            notification.close();
          };
        }
      } else {
        // Tab is visible and focused — show in-app toast.
        const toastTitle = sender ? t("Email from: {sender}", { sender }) : t("New email");
        const toastDesc = subject
          ? t("Subject: {subject}", { subject })
          : count > 1
            ? t("{count} new emails", { count })
            : undefined;
        toast(toastTitle, {
          description: toastDesc,
          action: {
            label: t("View"),
            onClick: () => setActiveFolder(folder),
          },
        });
      }
    },
    [permission, prefs, activeAccount, setActiveFolder],
  );

  return {
    permission,
    showBanner,
    requestPermission,
    dismissBanner,
    handleEvent,
  };
}
