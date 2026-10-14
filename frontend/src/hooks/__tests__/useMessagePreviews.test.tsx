import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { apiGet } from "@/lib/api";
import { useMessagePreviews } from "../useMessagePreviews";
import type { MessageHeader } from "@/types/message";

vi.mock("@/lib/api", () => ({ apiGet: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function message(uid: number): MessageHeader {
  return { uid, folder: "INBOX", subject: "Hello", from_address: "sender@example.com", from_name: "Sender",
    to_addresses: "[]", cc_addresses: "[]", message_id: null, in_reply_to: null, reaction: null, tags: [],
    date: "2026-10-14", flags: "", size: 20, has_attachments: false, snippet: "" };
}
function setup(messages: MessageHeader[], enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(({ enabled }) => useMessagePreviews("INBOX", messages, enabled), { wrapper, initialProps: { enabled } });
}

it("loads missing previews in batches of at most 50 without blocking existing rows", async () => {
  vi.mocked(apiGet).mockResolvedValueOnce({ "1": "Beginning" }).mockResolvedValueOnce({ "51": "Last preview" });
  const { result } = setup(Array.from({ length: 51 }, (_, index) => message(index + 1)));
  await waitFor(() => expect(result.current["51"]).toBe("Last preview"));
  expect(result.current["1"]).toBe("Beginning");
  expect(apiGet).toHaveBeenCalledTimes(2);
  expect(vi.mocked(apiGet).mock.calls.map(([path]) => String(path).split("uids=")[1].split(",").length)).toEqual([50, 1]);
});

it("does not load previews for split mode or messages with an existing snippet", async () => {
  vi.mocked(apiGet).mockResolvedValue({ "1": "Beginning" });
  const { rerender, result } = setup([message(1), { ...message(2), snippet: "Already available" }], false);
  expect(apiGet).not.toHaveBeenCalled();
  rerender({ enabled: true });
  await waitFor(() => expect(result.current["1"]).toBe("Beginning"));
  expect(apiGet).toHaveBeenCalledWith("/folders/INBOX/previews?uids=1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
