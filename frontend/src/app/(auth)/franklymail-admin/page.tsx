"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUiStore } from "@/stores/useUiStore";
import { useTranslation } from "@/lib/i18n";

/** Preserve old bookmarks while keeping administration in the mail layout. */
export default function AdminRedirect() {
  const router = useRouter();
  const { t } = useTranslation();
  useEffect(() => { useUiStore.getState().setViewMode("users"); router.replace("/mail"); }, [router]);
  return <p className="p-6 text-sm text-muted-foreground">{t("Loading...")}</p>;
}
