"use client";

import { useQuery } from "@tanstack/react-query";

interface MailServerSettings {
  host: string;
  port: number;
  security: "SSL/TLS" | "STARTTLS";
}

export interface MailSetup {
  imap: MailServerSettings;
  smtp: MailServerSettings;
  apple_profile_url: string;
}

export function useMailSetup() {
  return useQuery<MailSetup>({
    queryKey: ["public-mail-setup"],
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/setup`,
        { credentials: "omit", signal },
      );
      if (!response.ok) throw new Error("Mail setup settings are unavailable.");
      return response.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}
