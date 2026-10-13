import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HelpPage from "../help/page";
import { useAuthStore } from "@/stores/useAuthStore";

const settings = {
  imap: { host: "imap.club.example", port: 993, security: "SSL/TLS" },
  smtp: { host: "smtp.club.example", port: 587, security: "STARTTLS" },
  apple_profile_url: "/api/setup/apple.mobileconfig",
};

const fetchMock = vi.fn<typeof fetch>();

function renderHelp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } },
  });
  return render(<QueryClientProvider client={client}><HelpPage /></QueryClientProvider>);
}

beforeEach(() => {
  useAuthStore.setState({ accounts: [], activeAccountId: null });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("public mail setup guide", () => {
  it("loads configured server settings without an account or authentication request", async () => {
    fetchMock.mockResolvedValue(Response.json(settings));
    renderHelp();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your club email.");
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/");
    const table = await screen.findByRole("table");
    expect(within(table).getByText("imap.club.example")).toBeInTheDocument();
    expect(within(table).getByText("smtp.club.example")).toBeInTheDocument();
    expect(within(table).getByText("587")).toBeInTheDocument();
    expect(within(table).getByText("STARTTLS")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/setup", {
      credentials: "omit",
      signal: expect.any(AbortSignal),
    });
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  it("offers the real server profile URL instead of a browser-generated file", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...settings, apple_profile_url: "/club/api/setup/apple.mobileconfig" }));
    renderHelp();

    expect(await screen.findByRole("link", { name: "Download iOS configuration" }))
      .toHaveAttribute("href", "/club/api/setup/apple.mobileconfig");
    expect(screen.getByRole("link", { name: /iPhone & iPad/ })).toHaveAttribute("href", "#apple");
    expect(screen.getByRole("link", { name: /Android & other mail apps/ })).toHaveAttribute("href", "#manual");
  });

  it("keeps download unavailable while settings load", () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    renderHelp();

    expect(screen.getByRole("status")).toHaveTextContent("Loading mail server settings");
    expect(screen.getByRole("button", { name: "Download iOS configuration" })).toBeDisabled();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows a useful retry when setup is unavailable, then restores settings and download", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: {} }, { status: 503 }));
    renderHelp();

    expect(await screen.findByRole("alert")).toHaveTextContent("Mail server settings are unavailable");
    expect(screen.queryByRole("link", { name: "Download iOS configuration" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    fetchMock.mockImplementation(async () => Response.json(settings));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("link", { name: "Download iOS configuration" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
