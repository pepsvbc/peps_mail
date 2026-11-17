import { translate as t, getLocale } from "@/lib/i18n";

/** Format bytes as human-readable file size. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Convert ISO date string to human-readable relative or absolute format. */
export function humanizeDate(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);

  if (diffMinutes < 1) return t("just now");
  if (diffMinutes < 60) {
    return diffMinutes === 1 ? t("1 minute ago") : t("{count} minutes ago", { count: diffMinutes });
  }
  if (diffHours < 24) {
    return diffHours === 1 ? t("1 hour ago") : t("{count} hours ago", { count: diffHours });
  }

  // Check if yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return t("yesterday");
  }

  // Older — show normal date
  return date.toLocaleString(getLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
