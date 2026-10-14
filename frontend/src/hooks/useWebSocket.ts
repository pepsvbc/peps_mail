"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/useAuthStore";
import { toast } from "sonner";
import { translate as t } from "@/lib/i18n";

export type WsStatus = "connected" | "connecting" | "disconnected";

export interface MailEvent {
  type: "NewMessages" | "FlagsChanged" | "FolderUpdated" | "DraftsUpdated";
  data?: {
    folder?: string;
    synced?: boolean;
    count?: number;
    latest_sender?: string;
    latest_subject?: string;
  };
}

interface WebSocketMessage {
  accountId: string;
  event: MailEvent;
}

/**
 * Connects to the backend WebSocket endpoint for real-time mail events.
 * Automatically reconnects with exponential backoff on disconnect.
 * Invalidates React Query caches when events arrive.
 */
export function useWebSocket(onEvent?: (event: MailEvent) => void) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<WsStatus>("disconnected");
  const [failCount, setFailCount] = useState(0);
  const onEventRef = useRef(onEvent);
  // Sync ref on every render so the WebSocket handler always calls the latest
  // callback without restarting the connection (intentionally no dep array).
  useEffect(() => {
    onEventRef.current = onEvent;
  });
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(1000);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce WebSocket-driven cache invalidations (300ms quiet period).
  const pendingInvalidationsRef = useRef<Map<string, string[]>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleInvalidation = useCallback(
    (queryKey: string[]) => {
      pendingInvalidationsRef.current.set(JSON.stringify(queryKey), queryKey);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = setTimeout(() => {
        for (const key of pendingInvalidationsRef.current.values()) {
          queryClient.invalidateQueries({ queryKey: key });
        }
        pendingInvalidationsRef.current.clear();
        flushTimerRef.current = null;
      }, 300);
    },
    [queryClient],
  );

  useEffect(() => {
    let disposed = false;
    const pendingInvalidations = pendingInvalidationsRef.current;

    const connect = () => {
      if (disposed) return;

      setStatus("connecting");

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
      const ws = new WebSocket(`${protocol}//${window.location.host}${basePath}/api/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return;
        setStatus("connected");
        setFailCount(0);
        backoffRef.current = 1000; // Reset backoff on successful connect
        queryClient.invalidateQueries({ queryKey: ["account-unread"] });
      };

      ws.onmessage = (event) => {
        if (disposed || wsRef.current !== ws) return;
        try {
          const message: WebSocketMessage = JSON.parse(event.data);
          const mailEvent = message.event;
          const accountId = message.accountId;

          if (mailEvent.type === "NewMessages" || mailEvent.type === "FlagsChanged" || mailEvent.type === "FolderUpdated") {
            scheduleInvalidation(["account-unread", accountId]);
          }

          const activeAccountId = useAuthStore.getState().activeAccountId;
          if (accountId !== activeAccountId) {
            return;
          }

          onEventRef.current?.(mailEvent);

          switch (mailEvent.type) {
            case "DraftsUpdated":
              scheduleInvalidation(["drafts"]);
              scheduleInvalidation(["messages"]);
              scheduleInvalidation(["folders"]);
              if (mailEvent.data?.synced === false) {
                toast.warning(t("Draft saved locally, but mail server sync failed. Reopen it and save to retry."));
              }
              break;
            case "NewMessages":
              if (mailEvent.data?.folder) {
                scheduleInvalidation(["messages", mailEvent.data.folder]);
              }
              scheduleInvalidation(["folders"]);
              break;
            case "FlagsChanged":
              if (mailEvent.data?.folder) {
                scheduleInvalidation(["messages", mailEvent.data.folder]);
              }
              scheduleInvalidation(["folders"]);
              break;
            case "FolderUpdated":
              scheduleInvalidation(["folders"]);
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (disposed || wsRef.current !== ws) return;
        setStatus("disconnected");
        setFailCount((c) => c + 1);
        wsRef.current = null;

        // Reconnect with exponential backoff
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, 30000);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose will fire after onerror, which handles reconnection
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
      pendingInvalidations.clear();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [queryClient, scheduleInvalidation]);

  return { status, failCount };
}
