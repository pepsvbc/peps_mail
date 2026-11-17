import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";
import { useLanguageStore } from "@/lib/i18n";
import { useAuthStore } from "@/stores/useAuthStore";
import { useUiStore } from "@/stores/useUiStore";
import type { DistributionList } from "@/types/list";
import { DistributionListSettings } from "../DistributionListSettings";

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
  return render(<QueryClientProvider client={client}><DistributionListSettings /></QueryClientProvider>);
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
    // Non-admins always create personal lists and never see the access editor.
    expect(within(dialog).queryByRole("radio", { name: /^Shared/ })).toBeNull();
    expect(within(dialog).queryByLabelText("Who can use this list")).toBeNull();

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
      kind: "personal",
      display_mode: "expanded",
      members: [{ email: "lea@example.com", name: "" }, { email: "jean@example.com", name: "Jean Dupont" }],
    }));
  });

  it("lets admins create a shared list and choose who can use or edit it", async () => {
    setAdmin(true);
    mockServer([], ["coach@example.com", "parent@example.com"]);
    renderSettings();
    await screen.findByText("No lists have been shared with you.");
    fireEvent.click(screen.getByRole("button", { name: "New list" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByRole("radio", { name: /^Personal/ })).toBeChecked();
    expect(within(dialog).queryByLabelText("Who can use this list")).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^Shared/ }));

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Coaches" } });
    addMember("coach@example.com");

    const accessInput = within(dialog).getByLabelText("Who can use this list");
    fireEvent.focus(accessInput);
    fireEvent.change(accessInput, { target: { value: "coach" } });
    fireEvent.mouseDown(await within(dialog).findByRole("option", { name: "coach@example.com" }));
    fireEvent.change(accessInput, { target: { value: "new.parent@example.com" } });
    fireEvent.keyDown(accessInput, { key: "Enter" });
    fireEvent.click(within(dialog).getByRole("switch", { name: "coach@example.com can edit" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Create list" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/lists", {
      name: "Coaches",
      kind: "shared",
      display_mode: "list",
      members: [{ email: "coach@example.com", name: "" }],
      access: [{ email: "coach@example.com", can_edit: true }, { email: "new.parent@example.com", can_edit: false }],
    }));
  });

  it("shows shared lists read-only when the user cannot edit them", async () => {
    mockServer([makeList({ id: "shared-1", kind: "shared", can_edit: false, can_manage: false })]);
    renderSettings();
    const row = await screen.findByTestId("distribution-list-row");
    expect(row).toHaveTextContent("Shared");
    expect(row).toHaveTextContent("2 members · Shown as one list");
    expect(within(row).queryByRole("button", { name: "Edit Équipe U13" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Delete Équipe U13" })).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "View members of Équipe U13" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("You can use this list but not change it.")).toBeVisible();
    expect(within(dialog).getByRole("list", { name: "List members" })).toHaveTextContent("lea@example.com");
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Remove lea@example.com" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("lets non-admin editors of a shared list change it without touching access", async () => {
    mockServer([makeList({ id: "shared-1", kind: "shared", can_edit: true, can_manage: false })]);
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Équipe U13" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Who can use this list")).toBeNull();
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
