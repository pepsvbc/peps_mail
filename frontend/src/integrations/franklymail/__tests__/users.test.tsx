import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSettings } from "../AdminSettings";
import { apiGet, apiPost } from "@/lib/api";
import { useAuthStore } from "@/stores/useAuthStore";
import { useLanguageStore } from "@/lib/i18n";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn() }));
let recoveryEnabled = true;
function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><AdminSettings /></QueryClientProvider>);
}
beforeEach(() => {
  vi.resetAllMocks();
  recoveryEnabled = true;
  useLanguageStore.setState({ language: "en" });
  useAuthStore.setState({ activeAccountId: "admin", accounts: [{ id: "admin", email: "admin@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com", isAdmin: true }] });
  vi.mocked(apiGet).mockImplementation(async (path) => path.includes("/settings?") ? {
    forwarding: { enabled: false, address: "", keep_copy: true }, revision: "revision", existing_rules: false, externally_managed: false, recovery_email: "personal@elsewhere.org",
  } : { mailboxes: [{ id: "1", address: "alice@example.com" }, { id: "2", address: "bob@example.com" }], domains: ["example.com"], recovery_enabled: recoveryEnabled });
  vi.mocked(apiPost).mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("user management", () => {
  it("searches users and opens mailbox controls in a dialog", async () => {
    mount();
    await screen.findByRole("button", { name: "Manage alice@example.com" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search users" }), { target: { value: "alice" } });
    expect(screen.queryByRole("button", { name: "Manage bob@example.com" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Manage alice@example.com" }));
    const dialog = await screen.findByRole("dialog", { name: "Manage user" });
    expect((await within(dialog).findByLabelText("Personal email") as HTMLInputElement).value).toBe("personal@elsewhere.org");
    expect(within(dialog).getByText("Automatic forwarding")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([false, true])("handles creation with failure=%s without losing entered details", async (failure) => {
    if (failure) vi.mocked(apiPost).mockRejectedValue(new Error("This mailbox already exists"));
    mount();
    await screen.findByText("2 users");
    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    const dialog = await screen.findByRole("dialog", { name: "Add user" });
    fireEvent.change(within(dialog).getByLabelText("Mailbox address"), { target: { value: "new" } });
    fireEvent.change(within(dialog).getByLabelText("Personal email"), { target: { value: "personal@elsewhere.org" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create user and send invitation" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledExactlyOnceWith("/integrations/franklymail/mailboxes", { email: "new@example.com", personal_email: "personal@elsewhere.org" }));
    if (failure) {
      expect((await within(dialog).findByRole("alert")).textContent).toContain("already exists");
      expect((within(dialog).getByLabelText("Mailbox address") as HTMLInputElement).value).toBe("new");
    } else {
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  });


  it("shows the server domain and prevents existing names even when the user list is filtered", async () => {
    mount();
    await screen.findByText("2 users");
    fireEvent.change(screen.getByRole("textbox", { name: "Search users" }), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    const dialog = await screen.findByRole("dialog", { name: "Add user" });
    expect(within(dialog).getByText("@example.com")).toBeTruthy();
    const name = within(dialog).getByLabelText("Mailbox address");
    const submit = within(dialog).getByRole("button", { name: "Create user and send invitation" }) as HTMLButtonElement;
    fireEvent.change(within(dialog).getByLabelText("Personal email"), { target: { value: "personal@elsewhere.org" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(name, { target: { value: " ALICE " } });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("already taken");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(submit.disabled).toBe(true);
    fireEvent.submit(submit.closest("form")!);
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "new.name" } });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(submit.disabled).toBe(false);
  });

  it.each(["name@other.org", "first last", ".name", "name..last"])("rejects invalid local names: %s", async (value) => {
    mount();
    await screen.findByText("2 users");
    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    const dialog = await screen.findByRole("dialog", { name: "Add user" });
    fireEvent.change(within(dialog).getByLabelText("Mailbox address"), { target: { value } });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("valid mailbox name");
    const submit = within(dialog).getByRole("button", { name: "Create user and send invitation" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.submit(submit.closest("form")!);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("uses the configured dev domain instead of a hardcoded production domain", async () => {
    vi.mocked(apiGet).mockResolvedValue({ mailboxes: [], domains: ["tnq.test"], recovery_enabled: true });
    mount();
    await screen.findByText("No users yet.");
    fireEvent.click(screen.getByRole("button", { name: "Add user" }));
    const dialog = await screen.findByRole("dialog", { name: "Add user" });
    expect(within(dialog).getByText("@tnq.test")).toBeTruthy();
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Mailbox address"), { target: { value: "New.Name" } });
    fireEvent.change(within(dialog).getByLabelText("Personal email"), { target: { value: "personal@elsewhere.org" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create user and send invitation" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledExactlyOnceWith("/integrations/franklymail/mailboxes", { email: "new.name@tnq.test", personal_email: "personal@elsewhere.org" }));
  });

  it("explains unavailable email delivery while retaining mailbox management", async () => {
    recoveryEnabled = false;
    mount();
    await screen.findByText(/Welcome emails are not configured yet/);
    expect((screen.getByRole("button", { name: "Add user" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Manage bob@example.com" })).toBeTruthy();
  });


  it.each([false, true])("requires explicit address confirmation for deletion and handles failure=%s", async (failure) => {
    if (failure) vi.mocked(apiPost).mockRejectedValue(new Error("Provider could not confirm deletion"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Manage alice@example.com" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete user" });
    const submit = within(dialog).getByRole("button", { name: "Delete user" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(apiPost).not.toHaveBeenCalled();
    const confirmation = within(dialog).getByLabelText("Type alice@example.com to confirm");
    fireEvent.change(confirmation, { target: { value: "bob@example.com" } });
    fireEvent.submit(submit.closest("form")!);
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.change(confirmation, { target: { value: "alice@example.com" } });
    fireEvent.click(submit);
    await waitFor(() => expect(apiPost).toHaveBeenCalledExactlyOnceWith("/integrations/franklymail/mailboxes/delete", { email: "alice@example.com", mailbox_id: "1", confirmation: "alice@example.com" }, { accountId: "admin" }));
    if (failure) {
      expect((await within(dialog).findByRole("alert")).textContent).toContain("Provider could not confirm deletion");
      expect((confirmation as HTMLInputElement).value).toBe("alice@example.com");
    } else {
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
  });

  it("cancels deletion without sending a request and prevents deleting the active account", async () => {
    useAuthStore.setState({ accounts: [{ id: "admin", email: "alice@example.com", imapHost: "imap.example.com", smtpHost: "smtp.example.com", isAdmin: true }] });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Manage alice@example.com" }));
    expect((await screen.findByRole("button", { name: "Delete user" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage bob@example.com" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete user" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Manage user" })).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("keeps another administrator's mailbox read-only", async () => {
    vi.mocked(apiGet).mockImplementation(async (path) => path.includes("/settings?") ? {
      forwarding: { enabled: false, address: "", keep_copy: true }, revision: "revision", existing_rules: false, externally_managed: false, recovery_email: "boss@elsewhere.org", protected: true,
    } : { mailboxes: [{ id: "3", address: "boss@example.com", protected: true }], domains: ["example.com"], recovery_enabled: true });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Manage boss@example.com" }));
    const dialog = await screen.findByRole("dialog", { name: "Manage user" });
    expect(await within(dialog).findByText(/Only its owner can change its recovery address or forwarding/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Personal email") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Save address and send password link" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Save forwarding" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Delete user" }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("labels the users page and creation action in French", async () => {
    useLanguageStore.setState({ language: "fr" });
    mount();
    expect(await screen.findByRole("heading", { name: "Utilisateurs" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ajouter un utilisateur" })).toBeTruthy();
  });
});
