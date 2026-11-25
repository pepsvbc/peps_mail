import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Home from "../page";
import { AddAccountModal } from "@/components/accounts/AddAccountModal";
import { apiGet, apiPost, fetchAccounts } from "@/lib/api";
import { useAuthStore, type Account } from "@/stores/useAuthStore";
import { useUiStore } from "@/stores/useUiStore";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn(), fetchAccounts: vi.fn() }));

const existingAccount: Account = {
  id: "existing-account",
  email: "first@example.com",
  imapHost: "imap.example.com",
  smtpHost: "smtp.example.com",
};
const newAccount: Account = {
  ...existingAccount,
  id: "new-account",
  email: "second@example.com",
};

function enterCredentials(remember = false) {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: newAccount.email },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "test-password" },
  });
  if (remember) fireEvent.click(screen.getByLabelText("Keep me logged in"));
}

beforeEach(() => {
  vi.resetAllMocks();
  useAuthStore.setState({ accounts: [], activeAccountId: null });
  useUiStore.setState({ effectiveAnimationMode: "off" });
  vi.mocked(fetchAccounts).mockResolvedValue({ accounts: [] });
  vi.mocked(apiGet).mockResolvedValue({ franklymail: false, franklymail_recovery: false });
  vi.mocked(apiPost).mockResolvedValue({ account: newAccount });
});

afterEach(cleanup);

describe("sign in", () => {
  it.each([false, true])("sends only credentials and remember=%s, then activates the account", async (remember) => {
    render(<QueryClientProvider client={new QueryClient()}><Home /></QueryClientProvider>);
    await screen.findByLabelText("Email");
    expect(screen.getByRole("link", { name: "Need help setting up your email?" }).getAttribute("href")).toBe("/help");
    expect(screen.queryByText(/server configuration/i)).toBeNull();
    vi.mocked(fetchAccounts).mockResolvedValue({ accounts: [newAccount] });
    enterCredentials(remember);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/mail"));
    expect(apiPost).toHaveBeenCalledExactlyOnceWith("/auth/login", {
      email: newAccount.email,
      password: "test-password",
      remember,
    });
    expect(useAuthStore.getState().accounts).toEqual([newAccount]);
    expect(useAuthStore.getState().activeAccountId).toBe(newAccount.id);
  });

  it("redirects an already signed-in browser to the mailbox", async () => {
    vi.mocked(fetchAccounts).mockResolvedValue({ accounts: [existingAccount] });
    render(<QueryClientProvider client={new QueryClient()}><Home /></QueryClientProvider>);

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/mail"));
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("shows rejected credentials and enables retry without navigating", async () => {
    vi.mocked(apiPost).mockRejectedValue(new Error("Invalid credentials"));
    render(<QueryClientProvider client={new QueryClient()}><Home /></QueryClientProvider>);
    await screen.findByLabelText("Email");
    enterCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid credentials")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accounts).toEqual([]);
  });
});

describe("adding another account", () => {
  function renderModal() {
    const client = new QueryClient();
    client.setQueryData(["messages", existingAccount.id], ["cached message"]);
    client.setQueryData(["account-unread", existingAccount.id], { inbox_unread_count: 5 });
    const onClose = vi.fn();
    const modal = (open: boolean) => (
      <QueryClientProvider client={client}>
        <AddAccountModal open={open} onClose={onClose} />
      </QueryClientProvider>
    );
    const view = render(modal(true));
    return { ...view, client, onClose, modal };
  }

  beforeEach(() => {
    useAuthStore.setState({ accounts: [existingAccount], activeAccountId: existingAccount.id });
  });

  it("uses the same credential-only login and preserves existing accounts", async () => {
    vi.mocked(fetchAccounts).mockResolvedValue({ accounts: [existingAccount, newAccount] });
    const { client, onClose } = renderModal();
    expect(screen.queryByText(/server configuration/i)).toBeNull();
    enterCredentials(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(apiPost).toHaveBeenCalledExactlyOnceWith("/auth/login", {
      email: newAccount.email,
      password: "test-password",
      remember: true,
    });
    expect(useAuthStore.getState().accounts).toEqual([existingAccount, newAccount]);
    expect(useAuthStore.getState().activeAccountId).toBe(newAccount.id);
    expect(client.getQueryData(["messages", existingAccount.id])).toBeUndefined();
    expect(client.getQueryData(["account-unread", existingAccount.id])).toEqual({ inbox_unread_count: 5 });
  });

  it("keeps the existing account and cache after failed authentication", async () => {
    vi.mocked(apiPost).mockRejectedValue(new Error("Invalid credentials"));
    const { client, onClose } = renderModal();
    enterCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Invalid credentials")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accounts).toEqual([existingAccount]);
    expect(useAuthStore.getState().activeAccountId).toBe(existingAccount.id);
    expect(client.getQueryData(["messages", existingAccount.id])).toEqual(["cached message"]);
  });

  it("shows an account refresh failure without activating an unavailable account", async () => {
    vi.mocked(fetchAccounts).mockRejectedValue(new Error("Could not refresh accounts"));
    const { onClose } = renderModal();
    enterCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Could not refresh accounts")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(useAuthStore.getState().activeAccountId).toBe(existingAccount.id);
  });

  it("clears credentials, remember choice and errors when reopened", async () => {
    vi.mocked(apiPost).mockRejectedValue(new Error("Invalid credentials"));
    const { rerender, modal } = renderModal();
    enterCredentials(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("Invalid credentials");

    rerender(modal(false));
    rerender(modal(true));

    expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Keep me logged in") as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText("Invalid credentials")).toBeNull();
  });
});


describe("short mailbox login", () => {
  it.each([false, true])("accepts a short name with the server domain (add account=%s)", async (adding) => {
    vi.mocked(apiGet).mockImplementation(async (path) => path === "/auth/options" ? { default_domain: "tnq.ch" } : { franklymail:false, franklymail_recovery:false });
    if (adding) useAuthStore.setState({ accounts: [existingAccount], activeAccountId: existingAccount.id });
    const account = { ...newAccount, email: "admin@tnq.ch" };
    vi.mocked(apiPost).mockResolvedValue({ account });
    render(<QueryClientProvider client={new QueryClient()}>{adding ? <AddAccountModal open onClose={vi.fn()} /> : <Home />}</QueryClientProvider>);
    const identifier = await screen.findByLabelText("Email or username");
    expect((identifier as HTMLInputElement).type).toBe("text");
    expect(screen.getByText("You can leave out @tnq.ch.")).toBeTruthy();
    vi.mocked(fetchAccounts).mockResolvedValue({ accounts: adding ? [existingAccount, account] : [account] });
    fireEvent.change(identifier, { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledExactlyOnceWith("/auth/login", {email:"admin", password:"test-password", remember:false}));
    await waitFor(() => expect(useAuthStore.getState().activeAccountId).toBe(account.id));
    expect(useAuthStore.getState().accounts.find((a) => a.id === account.id)?.email).toBe("admin@tnq.ch");
  });
});
