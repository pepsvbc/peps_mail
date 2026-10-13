export const STORAGE_KEYS = {
  theme: "peps-mail-theme",
  language: "peps-mail-language",
  uiSettings: "peps-mail-ui-settings",
  activeAccountId: "peps-mail-active-account-id",
  notificationBannerDismissed: "peps-mail-notif-banner-dismissed",
} as const;

type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

export function readStoredPreference(key: StorageKey): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStoredPreference(key: StorageKey, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Settings still apply in memory when browser storage is unavailable.
  }
}
