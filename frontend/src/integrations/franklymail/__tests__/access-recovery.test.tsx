import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSettings } from "../../ProviderSettings";
import { ProviderRecoveryLink } from "../../ProviderRecoveryLink";
import { RecoveryPage } from "../RecoveryPage";
import { AdminPage } from "../AdminPage";
import { apiGet, apiPost } from "@/lib/api";
import { useUiStore } from "@/stores/useUiStore";
import { useAuthStore } from "@/stores/useAuthStore";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn() }));
function mount(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>);
}
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null,"","/");
  useAuthStore.setState({ activeAccountId:"member",accounts:[{ id:"member",email:"member@example.com",imapHost:"imap.example.com",smtpHost:"smtp.example.com",isAdmin:false }] });
  vi.mocked(apiGet).mockImplementation(async (path) => path.endsWith("/account") ? { change_password:true } : { franklymail:true,franklymail_recovery:true });
  vi.mocked(apiPost).mockResolvedValue({ ok:true });
});
afterEach(cleanup);

describe("optional provider access", () => {
  it("hides administration from non-admins even when enabled", async () => {
    mount(<><ProviderSettings /><AdminPage /></>);
    await screen.findByText("Administrator access is required.");
    expect(screen.queryByRole("button", { name: /Manage users/ })).toBeNull();
    expect(vi.mocked(apiGet).mock.calls.every(([path]) => ["/integrations/capabilities", "/integrations/franklymail/account"].includes(path))).toBe(true);
  });
  it("shows administration to FranklyMail admins only when enabled", async () => {
    vi.mocked(apiGet).mockImplementation(async (path) => path.endsWith("/account") ? { change_password:true,admin:true } : { franklymail:true,franklymail_recovery:true });
    mount(<ProviderSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /Manage users/ }));
    expect(useUiStore.getState().viewMode).toBe("users");
  });
  it("does not treat distribution-list admins as FranklyMail admins", async () => {
    useAuthStore.setState({ accounts:useAuthStore.getState().accounts.map((a) => ({ ...a,isAdmin:true })) });
    vi.mocked(apiGet).mockImplementation(async (path) => path.endsWith("/account") ? { change_password:true,admin:false } : { franklymail:true,franklymail_recovery:true });
    mount(<><ProviderSettings /><AdminPage /></>);
    await screen.findByText("Administrator access is required.");
    expect(screen.queryByRole("button", { name: /Manage users/ })).toBeNull();
  });
  it("keeps generic installations free of provider UI", async () => {
    vi.mocked(apiGet).mockResolvedValue({ franklymail:false,franklymail_recovery:false });
    mount(<><ProviderSettings /><ProviderRecoveryLink /></>);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /Manage users/ })).toBeNull();
  });
});

describe("password setup and recovery", () => {
  it("does not consume a link on page load, clears its URL fragment and submits only matching passwords", async () => {
    window.history.replaceState(null,"","/franklymail-recovery#token=one-time-token");
    mount(<RecoveryPage />);
    await screen.findByLabelText("New password");
    expect(window.location.hash).toBe("");
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("New password"),{target:{value:"new-secret-password"}});
    fireEvent.change(screen.getByLabelText("Confirm password"),{target:{value:"different-password"}});
    fireEvent.click(screen.getByRole("button",{name:"Set password"}));
    expect((await screen.findByRole("alert")).textContent).toContain("do not match");
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Confirm password"),{target:{value:"new-secret-password"}});
    fireEvent.click(screen.getByRole("button",{name:"Set password"}));
    await waitFor(() => expect(apiPost).toHaveBeenCalledExactlyOnceWith("/integrations/franklymail/recovery/reset",{token:"one-time-token",new_password:"new-secret-password"}));
  });
  it("requests a reset without exposing the personal address", async () => {
    mount(<RecoveryPage />);
    fireEvent.change(await screen.findByLabelText("Mailbox address"),{target:{value:"member@example.com"}});
    fireEvent.click(screen.getByRole("button",{name:"Send password link"}));
    await screen.findByRole("status");
    expect(apiPost).toHaveBeenCalledExactlyOnceWith("/integrations/franklymail/recovery/request",{email:"member@example.com"});
  });
});


describe("settings password change", () => {
  async function fill() {
    fireEvent.change(await screen.findByLabelText("Current password"), {target:{value:"old-secret-password"}});
    fireEvent.change(screen.getByLabelText("New password"), {target:{value:"new-secret-password"}});
    fireEvent.change(screen.getByLabelText("Confirm password"), {target:{value:"new-secret-password"}});
  }
  it("lets a non-admin change only the active mailbox password and keeps other accounts", async () => {
    useAuthStore.setState({accounts:[...useAuthStore.getState().accounts,{id:"other",email:"other@example.com",imapHost:"imap.example.com",smtpHost:"smtp.example.com"}]});
    mount(<ProviderSettings />);
    await fill();
    fireEvent.click(screen.getByRole("button",{name:"Change password"}));
    await waitFor(() => expect(useAuthStore.getState().activeAccountId).toBe("other"));
    expect(apiPost).toHaveBeenCalledExactlyOnceWith("/integrations/franklymail/password",{current_password:"old-secret-password",new_password:"new-secret-password"},{accountId:"member"});
    expect(useAuthStore.getState().accounts.map((a) => a.id)).toEqual(["other"]);
  });
  it("rejects mismatched confirmation and retains the session on server errors", async () => {
    mount(<ProviderSettings />);
    await fill();
    fireEvent.change(screen.getByLabelText("Confirm password"), {target:{value:"does-not-match"}});
    fireEvent.click(screen.getByRole("button",{name:"Change password"}));
    expect((await screen.findByRole("alert")).textContent).toContain("do not match");
    expect(apiPost).not.toHaveBeenCalled();
    vi.mocked(apiPost).mockRejectedValue(new Error("The current password is incorrect"));
    fireEvent.change(screen.getByLabelText("Confirm password"), {target:{value:"new-secret-password"}});
    fireEvent.click(screen.getByRole("button",{name:"Change password"}));
    await screen.findByText("The current password is incorrect");
    expect(useAuthStore.getState().activeAccountId).toBe("member");
  });
  it("hides password changes for an ineligible account", async () => {
    vi.mocked(apiGet).mockImplementation(async (path) => path.endsWith("/account") ? { change_password:false } : { franklymail:true,franklymail_recovery:true });
    mount(<ProviderSettings />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/integrations/franklymail/account",{accountId:"member"}));
    expect(screen.queryByLabelText("Current password")).toBeNull();
  });
});
