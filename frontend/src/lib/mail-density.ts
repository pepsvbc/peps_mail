export type MailDensity = "compact" | "standard" | "comfortable";

export const DEFAULT_MAIL_DENSITY: MailDensity = "standard";

/** Card height plus the 8px gap, shared by virtualization and keyboard scrolling. */
export const MESSAGE_ROW_HEIGHT: Record<MailDensity, number> = {
  compact: 44,
  standard: 72,
  comfortable: 96,
};
