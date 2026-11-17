import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { useLanguageStore } from "@/lib/i18n";
import { useAuthStore } from "@/stores/useAuthStore";
import { useUiStore } from "@/stores/useUiStore";
import type { DistributionList } from "@/types/list";
import { DistributionListsPage } from "../DistributionListsPage";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
vi.mock("@/hooks/useAutocomplete", () => ({ useAutocomplete: () => ({ results: [], isLoading: false }) }));

function makeList(overrides: Partial<DistributionList>): DistributionList {
  return {
    id: "list-1", name: "Équipe U13", kind: "personal", display_mode: "list", owner_email: "me@example.com",
    members: [{ email: "lea@example.com", name: "Léa Martin" }, { email: "jean@example.com", name: "" }],
    can_edit: true, can_manage: true, access: null, created_at: "", updated_at: "",
    ...overrides,
  };
}

function mockServer(lists: DistributionList[], users: string[] = []) {
  vi.mocked(apiGet).mockImplementation((async (path: string) => {
    if (path === "/lists") return { lists };
    if (path === "/lists/users") return { users: users.map((email) => ({ email, last_login: "2026-11-01T00:00:00Z" })) };
    throw new Error(`unexpected ${path}`);
  }) as typeof apiGet);
  vi.mocked(apiPost).mockImplementation((async (_path: string, body: Record<string, unknown>) => ({ ...makeList({}), ...body })) as typeof apiPost);
  vi.mocked(apiPut).mockImplementation((async () => makeList({})) as typeof apiPut);
  vi.mocked(apiDelete).mockResolvedValue({ status: "deleted" });
}

function setAdmin(isAdmin: boolean) {
  useAuthStore.setState({
    activeAccountId: "a",
    accounts: [{ id: "a", email: "me@example.com", imapHost: "imap", smtpHost: "smtp", isAdmin }],
  });
}

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><DistributionListsPage /></QueryClientProvider>);
}

function addMember(address: string) {
  const input = screen.getByLabelText("Members");
  fireEvent.change(input, { target: { value: address } });
  fireEvent.keyDown(input, { key: "Enter" });
}

beforeEach(() => {
  vi.resetAllMocks();
  useLanguageStore.setState({ language: "en" });
  useUiStore.setState({ effectiveAnimationMode: "off" });
  setAdmin(false);
});

afterEach(cleanup);

describe("distribution list settings", () => {
  it("shows empty states and creates a personal list with validated, de-duplicated members", async () => {
    mockServer([]);
    renderSettings();
    expect(await screen.findByText("You have no lists yet. Create one to write to a group in one go.")).toBeVisible();
    expect(screen.getByText("No lists have been shared with you.")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "New list" }));
    const dialog = await screen.findByRole("dialog");
    // Non-admins never see "Share with": their lists stay personal.
    expect(within(dialog).queryByRole("radio", { name: /^Shared/ })).toBeNull();
    expect(within(dialog).queryByLabelText("Share with")).toBeNull();

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Équipe U13" } });
    addMember("lea@example.com");
    addMember("not-an-address");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Not a valid email address: not-an-address");
    fireEvent.change(within(dialog).getByLabelText("Members"), { target: { value: "" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Paste addresses" }));
    fireEvent.change(within(dialog).getByLabelText("Addresses to add"), {
      target: { value: "Jean Dupont <jean@example.com>; LEA@example.com\n\"Martin, Paul\" <paul@example.com>" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add addresses" }));
    expect(within(dialog).getByText("1 address was already in the list")).toBeVisible();
    expect(within(dialog).getByTestId("list-member-count")).toHaveTextContent("3 members");

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove paul@example.com" }));
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Show every address/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create list" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/lists", {
      name: "Équipe U13",
      display_mode: "expanded",
      members: [{ email: "lea@example.com", name: "" }, { email: "jean@example.com", name: "Jean Dupont" }],
    }));
  });

  it("shares a list with the people an admin adds, each with a role, including one still being typed", async () => {
    setAdmin(true);
    mockServer([], ["coach@example.com", "parent@example.com"]);
    renderSettings();
    await screen.findByText("No lists have been shared with you.");
    fireEvent.click(screen.getByRole("button", { name: "New list" }));
    const dialog = await screen.findByRole("dialog");

    // No personal/shared choice: sharing depends only on the people added.
    expect(within(dialog).queryByRole("radio", { name: /^Shared/ })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Coaches" } });
    addMember("coach@example.com");

    const accessInput = within(dialog).getByLabelText("Share with");
    fireEvent.focus(accessInput);
    fireEvent.change(accessInput, { target: { value: "coach" } });
    fireEvent.mouseDown(await within(dialog).findByRole("option", { name: "coach@example.com" }));

    const people = within(dialog).getByRole("list", { name: "People with access" });
    const role = within(people).getByRole("combobox", { name: "Role of coach@example.com" });
    expect(role).toHaveValue("use");
    fireEvent.change(role, { target: { value: "edit" } });

    fireEvent.change(accessInput, { target: { value: "parent@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    fireEvent.click(within(people).getByRole("button", { name: "Remove access for parent@example.com" }));
    expect(within(people).queryByText("parent@example.com")).toBeNull();

    // Typed but not added yet: still shared on save.
    fireEvent.change(accessInput, { target: { value: "new.parent@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create list" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/lists", {
      name: "Coaches",
      display_mode: "list",
      members: [{ email: "coach@example.com", name: "" }],
      access: [{ email: "coach@example.com", can_edit: true }, { email: "new.parent@example.com", can_edit: false }],
    }));
  });

  it("does not save when the person being typed in Share with is not an address", async () => {
    setAdmin(true);
    mockServer([]);
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "New list" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Coaches" } });
    fireEvent.change(within(dialog).getByLabelText("Share with"), { target: { value: "coach" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create list" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Not a valid email address: coach");
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("expands a list to show its members and who it is shared with", async () => {
    setAdmin(true);
    mockServer([makeList({
      id: "shared-1", kind: "shared",
      access: [{ email: "coach@example.com", can_edit: true }, { email: "parent@example.com", can_edit: false }],
    })]);
    renderSettings();
    const row = await screen.findByTestId("distribution-list-row");
    const toggle = within(row).getByRole("button", { name: /^Équipe U13/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(row).queryByRole("list", { name: "Members of Équipe U13" })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(row).getByRole("list", { name: "Members of Équipe U13" })).toHaveTextContent("Léa Martin <lea@example.com>");
    const access = within(row).getByRole("list", { name: "People with access to Équipe U13" });
    expect(access).toHaveTextContent("coach@example.comCan use and edit");
    expect(access).toHaveTextContent("parent@example.comCan use");

    fireEvent.click(toggle);
    expect(within(row).queryByRole("list", { name: "Members of Équipe U13" })).toBeNull();
  });

  it("shows shared lists read-only, with the user's own role, when they cannot edit them", async () => {
    mockServer([makeList({ id: "shared-1", kind: "shared", can_edit: false, can_manage: false })]);
    renderSettings();
    const row = await screen.findByTestId("distribution-list-row");
    expect(row).toHaveTextContent("Shared");
    expect(row).toHaveTextContent("2 members · Shown as one list");
    expect(within(row).queryByRole("button", { name: "Edit Équipe U13" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Delete Équipe U13" })).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: /^Équipe U13/ }));
    expect(within(row).getByRole("list", { name: "Members of Équipe U13" })).toHaveTextContent("jean@example.com");
    expect(row).toHaveTextContent("Shared with");
    expect(row).toHaveTextContent("YouCan use");
  });

  it("lets non-admin editors of a shared list change it without touching access", async () => {
    mockServer([makeList({ id: "shared-1", kind: "shared", can_edit: true, can_manage: false })]);
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Équipe U13" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Share with")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "U13 squad" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledWith("/lists/shared-1", {
      name: "U13 squad",
      display_mode: "list",
      members: [{ email: "lea@example.com", name: "Léa Martin" }, { email: "jean@example.com", name: "" }],
    }));
  });

  it("asks for confirmation before deleting a list", async () => {
    mockServer([makeList({})]);
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Équipe U13" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(apiDelete).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiDelete).toHaveBeenCalledWith("/lists/list-1"));
  });
});
