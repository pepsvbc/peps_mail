"use client";

import { Download, Mail, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMailSetup } from "@/hooks/useMailSetup";

const linkStyle = "font-medium text-primary underline underline-offset-4 hover:no-underline";
const stepStyle = "space-y-3 pl-5 text-sm leading-relaxed marker:font-semibold marker:text-primary";

export function MailSetupGuide() {
  const { data: settings, isPending, isError, refetch, isFetching } = useMailSetup();
  const availableSettings = isError ? undefined : settings;

  return (
    <div className="space-y-12">
      {isPending && (
        <p role="status" className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
          Loading mail server settings…
        </p>
      )}
      {isError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card p-4">
          <p className="max-w-lg text-sm leading-relaxed">
            Mail server settings are unavailable right now. Try again to load
            the settings and iOS download, or contact your club mailbox administrator.
          </p>
          <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}>
            {isFetching ? "Retrying…" : "Try again"}
          </Button>
        </div>
      )}

      <section id="apple" aria-labelledby="apple-heading" className="scroll-mt-6 border-t border-border pt-8">
        <div className="mb-4 flex items-center gap-3">
          <Smartphone className="size-5 text-primary" aria-hidden="true" />
          <h2 id="apple-heading" className="text-2xl font-semibold tracking-tight">iPhone &amp; iPad</h2>
        </div>
        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
          The configuration profile fills in the server settings for Apple Mail.
          Your device will ask for your email address and password during installation.
        </p>

        <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
          <p className="mb-4 text-sm font-medium">Open this page in Safari on your iPhone or iPad.</p>
          {availableSettings ? (
            <Button asChild size="lg" className="h-auto min-h-11 whitespace-normal py-3">
              <a href={availableSettings.apple_profile_url}>
                <Download aria-hidden="true" />
                Download iOS configuration
              </a>
            </Button>
          ) : (
            <Button size="lg" disabled className="h-auto min-h-11 whitespace-normal py-3">
              <Download aria-hidden="true" />
              Download iOS configuration
            </Button>
          )}
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            peps-vbc-mail.mobileconfig · Configures your mail account only. No password is included in the file.
          </p>
          <ol className={`mt-6 list-decimal ${stepStyle}`}>
            <li>Tap the download button, then <strong>Allow</strong> when Safari asks to download the profile.</li>
            <li>Open <strong>Settings → Profile Downloaded</strong>. If it’s not shown, look in <strong>General → VPN &amp; Device Management</strong>.</li>
            <li>Review the mail profile, tap <strong>Install</strong> and enter your device passcode if asked.</li>
            <li>Enter your name, full email address and mailbox password when prompted. For each username, use your <strong>full email address</strong>.</li>
            <li>Finish installing, then open <strong>Mail</strong> and let your inbox sync.</li>
          </ol>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
            This profile is unsigned, so iOS may show “Not Signed”. You can review
            its mail settings before installing. Install it within 8 minutes of
            downloading, or download it again.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Each download adds a separate profile, so you can set up another mailbox.
            Remove any unused profiles in Settings → General → VPN &amp; Device Management.
          </p>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Prefer to enter the settings yourself? Use the <a href="#manual" className={linkStyle}>manual setup below</a>.
        </p>
      </section>

      <section id="manual" aria-labelledby="manual-heading" className="scroll-mt-6 border-t border-border pt-8">
        <div className="mb-4 flex items-center gap-3">
          <Mail className="size-5 text-primary" aria-hidden="true" />
          <h2 id="manual-heading" className="text-2xl font-semibold tracking-tight">IMAP &amp; SMTP setup</h2>
        </div>
        <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
          Works with Android, Outlook, Thunderbird, Apple Mail and other mail apps.
          <strong className="font-medium text-foreground"> IMAP receives and syncs your mail.</strong>
          <strong className="font-medium text-foreground"> SMTP sends it.</strong>
          {" "}Set up both so you can read and send messages.
        </p>
        <ol className={`mb-6 list-decimal ${stepStyle}`}>
          <li>In your mail app, choose <strong>Add account</strong>, then <strong>Other</strong> or <strong>IMAP</strong>.</li>
          <li>Enter your name, full email address and mailbox password. If automatic setup fails, choose <strong>Manual setup</strong>.</li>
          <li>Select <strong>IMAP</strong> and enter the incoming and outgoing settings below. Keep authentication enabled for the outgoing server, too.</li>
          <li>Save the account, let it sync, then send a test message to check outgoing mail.</li>
        </ol>

        {availableSettings && (
          <div className="hidden overflow-x-auto rounded-xl border border-border sm:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Incoming and outgoing mail server settings</caption>
              <thead className="bg-card">
                <tr>
                  <th scope="col" className="p-4 font-medium">Setting</th>
                  <th scope="col" className="p-4 font-semibold">Incoming (IMAP)</th>
                  <th scope="col" className="p-4 font-semibold">Outgoing (SMTP)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr>
                  <th scope="row" className="p-4 font-medium">Server</th>
                  <td className="break-all p-4 font-mono text-xs sm:text-sm">{availableSettings.imap.host}</td>
                  <td className="break-all p-4 font-mono text-xs sm:text-sm">{availableSettings.smtp.host}</td>
                </tr>
                <tr>
                  <th scope="row" className="p-4 font-medium">Port</th>
                  <td className="p-4 font-mono">{availableSettings.imap.port}</td>
                  <td className="p-4 font-mono">{availableSettings.smtp.port}</td>
                </tr>
                <tr>
                  <th scope="row" className="p-4 font-medium">Security</th>
                  <td className="p-4">{availableSettings.imap.security}</td>
                  <td className="p-4">{availableSettings.smtp.security}</td>
                </tr>
                <tr>
                  <th scope="row" className="p-4 font-medium">Username</th>
                  <td className="p-4">Your full email address</td>
                  <td className="p-4">Your full email address</td>
                </tr>
                <tr>
                  <th scope="row" className="p-4 font-medium">Password</th>
                  <td className="p-4">Your mailbox password</td>
                  <td className="p-4">Your mailbox password</td>
                </tr>
                <tr>
                  <th scope="row" className="p-4 font-medium">Authentication</th>
                  <td className="p-4">Password</td>
                  <td className="p-4">Required · Password</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {availableSettings && (
          <div className="space-y-4 sm:hidden">
            {[
              { label: "Incoming (IMAP)", server: availableSettings.imap },
              { label: "Outgoing (SMTP)", server: availableSettings.smtp },
            ].map(({ label, server }) => (
              <div key={label} className="overflow-hidden rounded-xl border border-border text-sm">
                <h3 className="bg-card px-4 py-3 font-semibold">{label}</h3>
                <dl className="space-y-4 p-4">
                  <div>
                    <dt className="mb-1 text-xs text-muted-foreground">Server</dt>
                    <dd className="break-all font-mono">{server.host}</dd>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div><dt className="mb-1 text-xs text-muted-foreground">Port</dt><dd className="font-mono">{server.port}</dd></div>
                    <div><dt className="mb-1 text-xs text-muted-foreground">Security</dt><dd>{server.security}</dd></div>
                  </div>
                </dl>
              </div>
            ))}
            <p className="text-sm leading-relaxed text-muted-foreground">
              For <strong className="font-medium text-foreground">both servers</strong>,
              use your full email address as the username and your mailbox password.
              Select password authentication, including for outgoing mail.
            </p>
          </div>
        )}

        <div className="mt-6 space-y-3">
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm font-medium">Android / Gmail</summary>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Tap your profile picture in Gmail, then <strong>Add another account → Other</strong>.
              Enter your address and choose <strong>Personal (IMAP)</strong>.
              Use the settings above for both servers.
            </p>
          </details>
          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer text-sm font-medium">Outlook / Thunderbird / other desktop apps</summary>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Add a mail account in the app’s account settings. Choose manual or
              advanced setup if needed, select <strong>IMAP</strong>, and use the
              incoming and outgoing settings above. Choose password authentication
              and use your full email address as the username for both servers.
            </p>
          </details>
        </div>
      </section>

      <section aria-labelledby="troubleshooting-heading" className="border-t border-border pt-8">
        <h2 id="troubleshooting-heading" className="mb-4 text-xl font-semibold">Need a hand?</h2>
        <ul className="list-disc space-y-3 pl-5 text-sm leading-relaxed text-muted-foreground">
          <li><strong className="font-medium text-foreground">Can receive but can’t send?</strong> Check the SMTP settings and make sure its username and password are filled in, even if your app labels them optional.</li>
          <li><strong className="font-medium text-foreground">Password rejected?</strong> Use your mailbox password and full email address. If your mail provider requires an app password for two-factor authentication, use that instead.</li>
          <li><strong className="font-medium text-foreground">Don’t have your mailbox details?</strong> Ask the club member who manages PEPS VBC email accounts.</li>
        </ul>
        <nav aria-label="Official setup guides" className="mt-6 flex flex-wrap gap-x-5 gap-y-3 text-sm">
          <a href="https://support.apple.com/en-us/102400" className={linkStyle} target="_blank" rel="noreferrer">Apple installation guide</a>
          <a href="https://support.google.com/mail/answer/6078445?hl=en&co=GENIE.Platform%3DAndroid" className={linkStyle} target="_blank" rel="noreferrer">Gmail for Android guide</a>
          <a href="https://support.mozilla.org/en-US/kb/manual-account-configuration" className={linkStyle} target="_blank" rel="noreferrer">Thunderbird setup guide</a>
        </nav>
      </section>
    </div>
  );
}
