import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLanguageStore } from "@/lib/i18n";
import { buildReplyBody, buildForwardBody, buildReplySubject, buildForwardSubject } from "../email-utils";
import { formatFolderName, findJunkFolder } from "../mail-folders";
import { humanizeDate } from "@/components/mail/ReadingPane/utils";

describe("mail localization", () => {
  beforeEach(() => {
    useLanguageStore.setState({ language: "fr" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
  });

  afterEach(() => {
    useLanguageStore.setState({ language: "en" });
    vi.useRealTimers();
  });

  it("translates special folder labels without changing custom names or IMAP destinations", () => {
    expect(formatFolderName("INBOX")).toBe("Boîte de réception");
    expect(formatFolderName("[Gmail]/Sent Mail")).toBe("Envoyés");
    expect(formatFolderName("Team archive")).toBe("Team archive");
    expect(findJunkFolder([{
      name: "Spam", attributes: ["\\Junk"], delimiter: "/",
      is_subscribed: true, total_count: 0, unread_count: 0,
    }])).toBe("Spam");
    useLanguageStore.setState({ language: "en" });
    expect(formatFolderName("INBOX")).toBe("Inbox");
  });

  it("uses French relative dates and Swiss French absolute dates", () => {
    expect(humanizeDate("2026-10-13T11:59:00Z")).toBe("il y a 1 minute");
    expect(humanizeDate("2026-10-13T11:58:00Z")).toBe("il y a 2 minutes");
    const past = "2026-01-03T10:20:00Z";
    expect(humanizeDate(past)).toBe(new Date(past).toLocaleString("fr-CH", {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    }));
    expect(humanizeDate("unparseable")).toBe("unparseable");
  });

  it("localizes generated quote headers while preserving the original message and subject prefixes", () => {
    const reply = buildReplyBody("Keep this exact message", "Alice", "2026-01-03T10:20:00Z");
    expect(reply).toContain("Alice a écrit :");
    expect(reply).toContain("> Keep this exact message");
    const forward = buildForwardBody("Original content", "Alice", "2026-01-03T10:20:00Z", "Meeting", "Bob");
    expect(forward).toContain("Message transféré");
    expect(forward).toContain("De : Alice");
    expect(forward).toContain("Objet : Meeting");
    expect(forward).toContain("À : Bob");
    expect(forward).toContain("Original content");
    expect(buildReplySubject("Meeting")).toBe("Re: Meeting");
    expect(buildForwardSubject("Meeting")).toBe("Fwd: Meeting");
  });
});
