"use client";

import { useTranslation } from "@/lib/i18n";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Lightbulb } from "lucide-react";
import { LanguageSwitcher } from "@/components/shared/LanguageSwitcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoginThemeToggle } from "@/components/shared/LoginThemeToggle";
import { apiPost, fetchAccounts } from "@/lib/api";
import { brand } from "@/lib/brand";
import { useAuthStore } from "@/stores/useAuthStore";

export default function Home() {
  const { t } = useTranslation();
  const router = useRouter();
  const setAccounts = useAuthStore((s) => s.setAccounts);
  const setActiveAccount = useAuthStore((s) => s.setActiveAccount);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAccounts()
      .then((data) => {
        if (!cancelled) {
          if (data.accounts.length > 0) {
            router.replace("/mail");
          } else {
            setChecking(false);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await apiPost<{
        account: { id: string; email: string; imapHost: string; smtpHost: string };
      }>("/auth/login", { email, password, remember });

      const accountsData = await fetchAccounts();
      setAccounts(accountsData.accounts);
      setActiveAccount(response.account.id);
      router.push("/mail");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("An unexpected error occurred"),
      );
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="size-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background px-6 py-6 text-foreground">
      <div className="flex flex-wrap justify-end gap-2">
        <LanguageSwitcher />
        <LoginThemeToggle />
      </div>
      <main className="flex flex-1 items-center justify-center py-10">
        <div className="w-full max-w-sm">
          {/* Branding */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 h-36 w-64 overflow-hidden">
              <Image
                src={brand.logoPath}
                alt={brand.name}
                width={256}
                height={256}
                className="-mt-14"
                priority
                unoptimized
              />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight"> {t("Sign in to Mail")} </h1>
          </div>

          {error && (
            <div role="alert" className="mb-4 rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">{t("Email")}</Label>
              <Input
                id="email"
                type="email"
                placeholder={t("you@example.com")}
                autoComplete="email"
                required
                disabled={loading}
                className="h-11 border-muted-foreground/80 bg-background text-foreground shadow-none dark:bg-background"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t("Password")}</Label>
              <Input
                id="password"
                type="password"
                placeholder={t("Enter your password")}
                autoComplete="current-password"
                required
                disabled={loading}
                className="h-11 border-muted-foreground/80 bg-background text-foreground shadow-none dark:bg-background"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <label htmlFor="remember" className="flex items-center gap-2 cursor-pointer select-none">
              <input
                id="remember"
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                disabled={loading}
                className="size-4 rounded border-muted-foreground accent-primary"
              />
              <span className="text-sm">{t("Keep me logged in")}</span>
            </label>

            <Button
              type="submit"
              className="mt-2 h-11 w-full"
              size="lg"
              disabled={loading}
            >
              {loading ? t("Signing in...") : t("Sign in")}
            </Button>
          </form>
          <Link
            href="/help"
            className="mt-6 flex min-h-11 items-center justify-center gap-2 rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <Lightbulb className="size-4 shrink-0" aria-hidden="true" /> {t("Need help setting up your email?")} </Link>
        </div>
      </main>
    </div>
  );
}
