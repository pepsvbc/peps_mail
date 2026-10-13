import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowDown, Monitor, Smartphone } from "lucide-react";
import { LoginThemeToggle } from "@/components/shared/LoginThemeToggle";
import { MailSetupGuide } from "@/components/help/MailSetupGuide";
import { brand } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Email setup · ${brand.name}`,
  description: "Set up your PEPS VBC email on iPhone, iPad, Android or your preferred mail app.",
};

export default function HelpPage() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-6">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to sign in
        </Link>
        <LoginThemeToggle />
      </header>

      <main className="mx-auto max-w-4xl px-6 pb-16">
        <div className="py-8 sm:py-12">
          <div className="mb-6 h-24 w-44 overflow-hidden">
            <Image
              src={brand.logoPath}
              alt={brand.name}
              width={176}
              height={176}
              className="-mt-10"
              priority
              unoptimized
            />
          </div>
          <p className="mb-3 text-sm font-semibold text-primary">EMAIL SETUP</p>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-5xl sm:leading-tight">
            Your club email.<br />On your favourite device.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground">
            Add your PEPS VBC mailbox to your phone or mail app. You’ll need
            your full email address and mailbox password — no webmail sign-in needed.
          </p>
          <nav aria-label="Setup options" className="mt-8 grid gap-3 sm:grid-cols-2">
            <a href="#apple" className="group flex items-center gap-4 rounded-xl border border-border bg-card p-5 hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
              <Smartphone className="size-6 shrink-0 text-primary" aria-hidden="true" />
              <span className="flex-1 font-medium">iPhone &amp; iPad<span className="mt-1 block text-sm font-normal text-muted-foreground">Download an Apple Mail profile</span></span>
              <ArrowDown className="size-4 text-primary" aria-hidden="true" />
            </a>
            <a href="#manual" className="group flex items-center gap-4 rounded-xl border border-border bg-card p-5 hover:border-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
              <Monitor className="size-6 shrink-0 text-primary" aria-hidden="true" />
              <span className="flex-1 font-medium">Android &amp; other mail apps<span className="mt-1 block text-sm font-normal text-muted-foreground">Set up with IMAP and SMTP</span></span>
              <ArrowDown className="size-4 text-primary" aria-hidden="true" />
            </a>
          </nav>
        </div>

        <MailSetupGuide />
      </main>
    </div>
  );
}
