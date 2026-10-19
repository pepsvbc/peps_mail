import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecipientInput } from "../ComposeDialog/RecipientInput";

vi.mock("@/hooks/useAutocomplete", () => ({ useAutocomplete: () => ({ results: [], isLoading: false }) }));
afterEach(cleanup);

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
