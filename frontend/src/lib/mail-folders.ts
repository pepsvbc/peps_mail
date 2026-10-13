import { translate as t } from "@/lib/i18n";
import type { Folder } from "@/types/folder";

export function findJunkFolder(folders: Folder[]): string | undefined {
  const special = folders.find(folder => folder.attributes?.some(attr => attr.toLowerCase() === "\\junk"));
  if (special) return special.name;
  return folders.find(folder => {
    const leaf = folder.delimiter ? folder.name.split(folder.delimiter).at(-1) : folder.name;
    return ["spam", "junk", "junk email", "junk e-mail"].includes(leaf?.toLowerCase() ?? "");
  })?.name;
}

/** Map raw folder names to user-friendly display names. */
export function formatFolderName(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "inbox") return t("Inbox");
  if (lower === "drafts" || lower === "[gmail]/drafts") return t("Drafts");
  if (lower === "sent" || lower === "[gmail]/sent mail") return t("Sent");
  if (lower === "trash" || lower === "[gmail]/trash") return t("Trash");
  if (lower === "junk" || lower === "spam" || lower === "[gmail]/spam") return t("Spam");
  if (lower === "archive" || lower === "[gmail]/all mail") return t("Archive");
  if (lower === "starred" || lower === "flagged") return t("Starred");
  return name;
}
