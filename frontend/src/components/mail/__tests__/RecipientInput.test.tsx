import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RecipientInput } from "../ComposeDialog/RecipientInput";
import { expandRecipients } from "@/lib/recipients";
import type { DistributionList } from "@/types/list";

const { lists } = vi.hoisted(() => ({ lists: { data: [] as DistributionList[] } }));

vi.mock("@/hooks/useAutocomplete", () => ({ useAutocomplete: () => ({ results: [], isLoading: false }) }));
vi.mock("@/hooks/useLists", () => ({ useLists: () => lists }));
afterEach(cleanup);
beforeEach(() => { lists.data = []; });
beforeAll(() => {
  // Radix popovers measure their anchor; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

function makeList(overrides: Partial<DistributionList>): DistributionList {
  return {
    id: "u13", name: "Équipe U13", kind: "shared", display_mode: "list", owner_email: "admin@example.com",
    members: [{ email: "lea@example.com", name: "Léa Martin" }, { email: "COACH@example.com", name: "" }],
    can_edit: false, can_manage: false, access: null, created_at: "", updated_at: "",
    ...overrides,
  };
}

function Field({ initial = "coach@example.com" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <><RecipientInput value={value} onChange={setValue} placeholder="Recipients" /><output data-testid="value">{value}</output></>;
}

describe("recipient chips", () => {
  it("keeps a prefilled recipient and lets the user immediately type another address", () => {
    render(<Field />);
    const input = screen.getByPlaceholderText("Recipients");
    expect(input).toHaveValue("");
    expect(screen.getByText("coach@example.com", { selector: "span" })).toBeVisible();
    fireEvent.change(input, { target: { value: "new@example.com" } });
    expect(input).toHaveValue("new@example.com");
    expect(screen.getByTestId("value")).toHaveTextContent("coach@example.com, new@example.com");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Remove new@example.com" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove coach@example.com" }));
    expect(screen.getByTestId("value").textContent).toBe("new@example.com, ");
  });

  it("leaves the active token unchanged when tabbing backwards", () => {
    render(<Field initial="" />);
    const input = screen.getByPlaceholderText("Recipients");
    fireEvent.change(input, { target: { value: "new@example.com" } });
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(input).toHaveValue("new@example.com");
    expect(screen.getByTestId("value").textContent).toBe("new@example.com");
  });

  it("allows editing the previous recipient with Backspace", () => {
    render(<Field />);
    const input = screen.getByPlaceholderText("Recipients");
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(input).toHaveValue("coach@example.com");
    fireEvent.change(input, { target: { value: "other@example.com" } });
    fireEvent.blur(input);
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Remove other@example.com" })).toBeVisible();
  });

  it("preserves spaces while typing a display name", () => {
    render(<Field initial="" />);
    const input = screen.getByPlaceholderText("Recipients");
    fireEvent.change(input, { target: { value: "Jane " } });
    expect(input).toHaveValue("Jane ");
    fireEvent.change(input, { target: { value: "Jane Doe <jane@example.com>" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Remove Jane Doe <jane@example.com>" })).toBeVisible();
  });
});

describe("distribution lists in recipient fields", () => {
  it("suggests matching lists above addresses with a member count", () => {
    lists.data = [makeList({}), makeList({ id: "seniors", name: "Seniors" })];
    render(<Field initial="" />);
    fireEvent.change(screen.getByPlaceholderText("Recipients"), { target: { value: "u1" } });
    const suggestions = screen.getAllByTestId("recipient-list-suggestion");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toHaveTextContent("Équipe U13");
    expect(suggestions[0]).toHaveTextContent("2 members");
  });

  it("respects the minimum query length", () => {
    lists.data = [makeList({})];
    render(<Field initial="" />);
    fireEvent.change(screen.getByPlaceholderText("Recipients"), { target: { value: "u" } });
    expect(screen.queryByTestId("recipient-list-suggestion")).toBeNull();
  });

  it("inserts every member of an expanded list, skipping addresses already present", () => {
    lists.data = [makeList({ display_mode: "expanded" })];
    render(<Field />);
    const input = screen.getByPlaceholderText("Recipients");
    fireEvent.change(input, { target: { value: "équipe" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove Léa Martin <lea@example.com>" })).toBeVisible();
    expect(screen.queryByTestId("recipient-list-chip")).toBeNull();
    // coach@example.com was already there (case-insensitive), so it is not added twice.
    expect(screen.getByTestId("value").textContent).toBe("coach@example.com, Léa Martin <lea@example.com>, ");
  });

  it("inserts one chip for a list-mode list and expands it when sending", () => {
    lists.data = [makeList({})];
    render(<Field initial="" />);
    const input = screen.getByPlaceholderText("Recipients");
    fireEvent.change(input, { target: { value: "U13" } });
    fireEvent.mouseDown(screen.getByTestId("recipient-list-suggestion"));
    const chip = screen.getByTestId("recipient-list-chip");
    expect(chip).toHaveTextContent("Équipe U13 (2)");
    const value = screen.getByTestId("value").textContent ?? "";
    expect(expandRecipients(value)).toEqual(["Léa Martin <lea@example.com>", "COACH@example.com"]);
    // The same list is not suggested twice in one field.
    fireEvent.change(input, { target: { value: "U13" } });
    expect(screen.queryByTestId("recipient-list-suggestion")).toBeNull();
  });

  it("shows the members and replaces the chip with individual recipients", () => {
    lists.data = [makeList({})];
    render(<Field initial="coach@example.com" />);
    const input = screen.getByPlaceholderText("Recipients");
    fireEvent.change(input, { target: { value: "U13" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Show members of Équipe U13 (2)" }));
    expect(screen.getByRole("list", { name: "List members" })).toHaveTextContent("lea@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Show all addresses" }));
    expect(screen.queryByTestId("recipient-list-chip")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove Léa Martin <lea@example.com>" })).toBeVisible();
    expect(screen.getByTestId("value").textContent).toBe("coach@example.com, Léa Martin <lea@example.com>, ");
  });

  it("removes the whole list with its remove button or Backspace", () => {
    lists.data = [makeList({})];
    render(<Field initial="" />);
    const input = screen.getByPlaceholderText("Recipients");
    fireEvent.change(input, { target: { value: "U13" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Remove Équipe U13" }));
    expect(screen.queryByTestId("recipient-list-chip")).toBeNull();
    expect(expandRecipients(screen.getByTestId("value").textContent ?? "")).toEqual([]);

    fireEvent.change(input, { target: { value: "U13" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("recipient-list-chip")).toBeVisible();
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.queryByTestId("recipient-list-chip")).toBeNull();
    expect(input).toHaveValue("");
  });
});
