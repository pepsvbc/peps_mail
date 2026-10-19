"use client";

import { create } from "zustand";

export function composeMessageKey(accountId: string | null, folder: string, uid: number | null) {
  return JSON.stringify([accountId, folder, uid]);
}

// The composer stays mounted in the app layout while its portal follows the reader.
export const useInlineComposeHost = create<{
  visibleMessageKey: string | null;
  element: HTMLDivElement | null;
  messageKey: string | null;
  setHost: (element: HTMLDivElement | null, messageKey: string) => void;
}>((set) => ({
  visibleMessageKey: null,
  element: null,
  messageKey: null,
  setHost: (element, messageKey) => set((state) =>
    element ? { element, messageKey } : state.messageKey === messageKey
      ? { element: null, messageKey: null } : state),
}));
