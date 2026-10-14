"use client";

import { useQueries } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { MessageHeader } from "@/types/message";

/** Load bounded previews separately so the inbox never waits for message bodies. */
export function useMessagePreviews(folder: string, messages: MessageHeader[], enabled: boolean) {
  const uids = enabled ? messages.filter((message) => message.folder === folder && !message.snippet).map((message) => message.uid) : [];
  const batches: number[][] = [];
  for (let index = 0; index < uids.length; index += 50) batches.push(uids.slice(index, index + 50));
  const results = useQueries({ queries: batches.map((batch) => ({
    queryKey: ["message-previews", folder, batch.join(",")],
    queryFn: ({ signal }: { signal: AbortSignal }) => apiGet<Record<string, string>>(
      `/folders/${encodeURIComponent(folder)}/previews?uids=${batch.join(",")}`, { signal },
    ),
    staleTime: Infinity,
    retry: 1,
  })) });
  return Object.assign({}, ...results.map((result) => result.data ?? {})) as Record<string, string>;
}
