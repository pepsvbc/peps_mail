import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { apiGet } from "@/lib/api";
import { useAutocomplete } from "../useAutocomplete";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function setup(query: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(({ query }) => useAutocomplete(query, 0), { wrapper, initialProps: { query } });
}

it("fuzzy-searches all known addresses from the address autocomplete endpoint", async () => {
  vi.mocked(apiGet).mockResolvedValue({
    suggestions: [
      { email: "alice@example.com", name: "Alice Martin", source: "known" },
      { email: "bob@example.com", name: "Bob Keller", source: "known" },
    ],
  });
  const { result } = setup("ali");

  await waitFor(() => expect(result.current.results).toHaveLength(1));
  expect(result.current.results[0].item).toEqual({ email: "alice@example.com", name: "Alice Martin", source: "known" });
  expect(apiGet).toHaveBeenCalledWith("/addresses/autocomplete/all");
  expect(apiGet).not.toHaveBeenCalledWith(expect.stringContaining("/contacts"));
});

it("falls back to server-side address search when no addresses are cached", async () => {
  vi.mocked(apiGet).mockImplementation((async (path: string) =>
    path === "/addresses/autocomplete/all"
      ? { suggestions: [] }
      : { suggestions: [{ email: "carla@example.com", name: "Carla", source: "known" }] }) as typeof apiGet);
  const { result } = setup("car");

  await waitFor(() => expect(result.current.results.map((r) => r.item.email)).toEqual(["carla@example.com"]));
  expect(apiGet).toHaveBeenCalledWith("/addresses/autocomplete?q=car&limit=20");
});
