import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { apiGet } from "../api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLanguageStore } from "@/lib/i18n";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  useLanguageStore.setState({ language: "en", preference: "system", initialized: false, hasStoredPreference: false });
  useAuthStore.setState({ accounts: [], activeAccountId: "active-account" });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ inbox_unread_count: 4 }),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  useLanguageStore.setState({ language: "en", preference: "system", initialized: false, hasStoredPreference: false });
  localStorage.removeItem("oxi-language");
});

describe("account-scoped requests", () => {
  it("defaults to the currently active account", async () => {
    await apiGet("/folders");

    expect(fetch).toHaveBeenCalledWith("/api/folders", expect.objectContaining({
      headers: { "X-Active-Account": "active-account" },
      credentials: "same-origin",
    }));
  });

  it("requests another account without changing the active account", async () => {
    const controller = new AbortController();
    await expect(apiGet("/account/unread", {
      accountId: "other-account",
      signal: controller.signal,
    })).resolves.toEqual({ inbox_unread_count: 4 });

    expect(fetch).toHaveBeenCalledWith("/api/account/unread", expect.objectContaining({
      headers: { "X-Active-Account": "other-account" },
      signal: controller.signal,
    }));
    expect(useAuthStore.getState().activeAccountId).toBe("active-account");
  });

  it("propagates unread request failures", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "Mailbox unavailable" } }),
    } as Response);

    await expect(apiGet("/account/unread", { accountId: "other-account" }))
      .rejects.toThrow("Mailbox unavailable");
  });

  it("does not remove or switch accounts, toast, or delete sessions for background expiry", async () => {
    const accounts = ["active-account", "other-account"].map((id) => ({
      id, email: `${id}@example.com`, imapHost: "imap.example.com", smtpHost: "smtp.example.com",
    }));
    useAuthStore.setState({ accounts });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: {
        code: "ACCOUNT_SESSION_EXPIRED", accountId: "active-account", message: "Account session expired",
      } }),
    } as Response);

    await expect(apiGet("/account/unread", { accountId: "active-account", handleSessionExpiry: false }))
      .rejects.toThrow("Account session expired");

    expect(useAuthStore.getState().accounts).toEqual(accounts);
    expect(useAuthStore.getState().activeAccountId).toBe("active-account");
    expect(toast.error).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps existing session-expiry handling for foreground requests", async () => {
    useAuthStore.setState({ accounts: ["active-account", "other-account"].map((id) => ({
      id, email: `${id}@example.com`, imapHost: "imap.example.com", smtpHost: "smtp.example.com",
    })) });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: {
        code: "ACCOUNT_SESSION_EXPIRED", accountId: "active-account", message: "Account session expired",
      } }),
    } as Response);

    await expect(apiGet("/folders")).rejects.toThrow("Account session expired");

    expect(useAuthStore.getState().accounts.map(({ id }) => id)).toEqual(["other-account"]);
    expect(useAuthStore.getState().activeAccountId).toBe("other-account");
    expect(toast.error).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/auth/accounts/active-account", expect.objectContaining({ method: "DELETE" }));
  });
});


describe("localized API errors", () => {
  beforeEach(() => useLanguageStore.getState().setLanguage("fr"));

  it("translates known sign-in failures", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { code: "UNAUTHORIZED", message: "Invalid email or password" } }),
    } as Response);
    await expect(apiGet("/test")).rejects.toThrow("Adresse e-mail ou mot de passe incorrect");
  });

  it("keeps unknown server details unchanged", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { code: "SERVICE_UNAVAILABLE", message: "IMAP error: custom server detail" } }),
    } as Response);
    await expect(apiGet("/test")).rejects.toThrow("IMAP error: custom server detail");
  });

  it("adds a French explanation without losing connection failure details", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { code: "SERVER_UNREACHABLE", message: "Connection timed out" } }),
    } as Response);
    await expect(apiGet("/test")).rejects.toThrow("Impossible de joindre le serveur de messagerie: Connection timed out");
  });

  it("translates the session-expiry toast and still removes the expired account", async () => {
    useAuthStore.setState({ accounts: [{ id: "active-account", email: "mail@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com" }] });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: { code: "ACCOUNT_SESSION_EXPIRED", accountId: "active-account", message: "Account session has expired" } }),
    } as Response);
    await expect(apiGet("/folders")).rejects.toThrow("La session du compte a expiré");
    expect(toast.error).toHaveBeenCalledWith("La session du compte a expiré");
    expect(useAuthStore.getState().accounts).toEqual([]);
  });
});
