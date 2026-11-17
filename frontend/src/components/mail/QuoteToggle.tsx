"use client";

import { Ellipsis } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Gmail-style "•••" button that shows or hides the quoted history of a message. */
export function QuoteToggle({
  expanded,
  onToggle,
  className,
}: {
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = expanded ? t("Hide previous messages") : t("Show previous messages");
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-4 items-center rounded-sm border border-border bg-muted px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <Ellipsis className="size-4" aria-hidden="true" />
    </button>
  );
}
