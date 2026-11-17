"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useLanguageStore, useTranslation } from "@/lib/i18n";
import { brand } from "@/lib/brand";

export function LanguageInitializer() {
  const initialize = useLanguageStore((state) => state.initialize);
  const { t, locale } = useTranslation();
  const pathname = usePathname();

  useEffect(() => { initialize(); }, [initialize]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return <title>{`${pathname.replace(/\/$/, "").endsWith("/help") ? t("Email setup") : "Mail"} · ${brand.name}`}</title>;
}
