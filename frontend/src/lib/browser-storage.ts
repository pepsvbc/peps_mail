export const STORAGE_KEYS = {
  theme: "peps-mail-theme",
  language: "peps-mail-language",
  uiSettings: "peps-mail-ui-settings",
  activeAccountId: "peps-mail-active-account-id",
  notificationBannerDismissed: "peps-mail-notif-banner-dismissed",
} as const;

type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

// These names are only used to migrate existing installations.
const legacyKeys: Record<StorageKey, string> = {
  [STORAGE_KEYS.theme]: "oxi-theme",
  [STORAGE_KEYS.language]: "oxi-language",
  [STORAGE_KEYS.uiSettings]: "oxi-ui-settings",
  [STORAGE_KEYS.activeAccountId]: "oxi-active-account-id",
  [STORAGE_KEYS.notificationBannerDismissed]: "oxi-notif-banner-dismissed",
};

export function readStoredPreference(key: StorageKey): string | null {
  try {
    const current = localStorage.getItem(key);
    const value = current ?? localStorage.getItem(legacyKeys[key]);
    if (value !== null) {
      try {
        // Keep the original if storage is full or writes are blocked.
        if (current === null) localStorage.setItem(key, value);
        localStorage.removeItem(legacyKeys[key]);
      } catch {
        // The saved value can still be used during this visit.
      }
    }
    return value;
  } catch {
    return null;
  }
}

export function writeStoredPreference(key: StorageKey, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    localStorage.removeItem(legacyKeys[key]);
  } catch {
    // Settings still apply in memory when browser storage is unavailable.
  }
}
