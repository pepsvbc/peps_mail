"use client";

import { useTranslation } from "@/lib/i18n";

import { Bell, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface NotificationBannerProps {
  onEnable: () => void;
  onDismiss: () => void;
}

export function NotificationBanner({ onEnable, onDismiss }: NotificationBannerProps) {
  const { t } = useTranslation();
  return (
    <div className="fixed top-0 left-0 right-0 z-50 flex items-center gap-3 border-b border-border bg-accent/50 px-4 py-2 backdrop-blur-sm">
      <Bell className="size-4 shrink-0 text-primary" />
      <p className="flex-1 text-sm text-foreground">
        {t("Enable desktop notifications to get alerted about new emails.")}
      </p>
      <Button size="xs" onClick={onEnable}>
        {t("Enable")}
      </Button>
      <Button variant="ghost" size="icon-xs" onClick={onDismiss} aria-label={t("Dismiss")}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
