import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IcsPreview } from "../ReadingPane/IcsPreview";
import { useLanguageStore } from "@/lib/i18n";

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "SUMMARY:Team training",
  "DTSTART:20261120T180000Z",
  "DTEND:20261120T200000Z",
  "LOCATION:Main hall",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const ICS_URL = "/api/messages/INBOX/42/attachments/att-1?account_id=a1";

beforeEach(() => {
  useLanguageStore.setState({ language: "en" });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => ICS })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useLanguageStore.setState({ language: "en" });
});

describe("IcsPreview", () => {
  it("previews the invitation and offers the original .ics as a download", async () => {
    render(<IcsPreview url={ICS_URL} filename="training.ics" />);

    expect(await screen.findByText("Team training")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Download invitation" });
    expect(link.getAttribute("href")).toBe(ICS_URL);
    expect(link.getAttribute("download")).toBe("training.ics");
    expect(screen.queryByRole("button", { name: /add to calendar/i })).toBeNull();
  });

  it("uses a sensible filename when the attachment has none", async () => {
    render(<IcsPreview url={ICS_URL} filename={null} />);

    const link = await screen.findByRole("link", { name: "Download invitation" });
    expect(link.getAttribute("download")).toBe("invite.ics");
  });

  it("translates the download action", async () => {
    useLanguageStore.setState({ language: "fr" });
    render(<IcsPreview url={ICS_URL} filename="training.ics" />);

    expect(await screen.findByRole("link", { name: "Télécharger l’invitation" })).toBeTruthy();
  });
});
