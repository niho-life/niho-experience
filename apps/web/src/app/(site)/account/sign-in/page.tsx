import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { config } from "@/lib/config";
import { PRIVACY_PATH } from "@/lib/privacy-link";
import { TRAVELER_HOME_PATH, TRAVELER_OFFERED_METHODS, TRAVELER_START_PATH, travelerLoginErrorOrNull, type TravelerLoginError } from "@/lib/traveler/paths";
import { readTravelerSession } from "@/lib/traveler/server";

export const metadata: Metadata = { title: "Log in or sign up", robots: { index: false, follow: false } };

const METHOD_LABELS = { google: "Continue with Google", apple: "Continue with Apple", line: "Continue with LINE" } as const;

/** What went wrong, in words that name nobody and no other service. */
const ERRORS: Record<TravelerLoginError, string> = {
  expired: "That took too long, or the login was not finished. Please try again.",
  denied: "The login was cancelled. You can try again whenever you like.",
  unavailable: "We couldn't log you in just now. Please try again in a little while.",
  suspended: "This account can't log in. Please contact us if you think this is a mistake.",
};

const BUTTON = "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border-[1.5px] border-ink bg-transparent px-6 text-[1rem] font-bold leading-tight text-ink transition-colors hover:bg-sand";

/**
 * Where a traveler logs in or signs up (Epic #591, #597, ADR 0004 §8). English, and no NIHO in front: a heading, a button for each
 * way in (it goes straight to that provider's own screen), one sentence of consent, and, last and small, the way in for someone who
 * already has a NIHO account (NIHO's own login screen). The buttons are plain forms: the page works without JavaScript. An account
 * is optional: booking as a guest is unchanged. `?error=` tells why a log in did not finish.
 */
export default async function TravelerSignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!config.travelerAccountsEnabled) notFound();
  if (await readTravelerSession()) redirect(TRAVELER_HOME_PATH);
  const error = travelerLoginErrorOrNull((await searchParams).error);
  return (
    <main id="main" className="container-page max-w-md py-10 sm:py-16">
      <h1 className="text-3xl">Log in or sign up</h1>
      {error ? <p role="alert" className="mt-4 rounded-xl bg-warn-pale p-3 text-warn">{ERRORS[error]}</p> : null}
      {/* A plain form: the route answers with a redirect to the provider's own screen. */}
      <form method="post" action={TRAVELER_START_PATH} className="mt-6 grid gap-3">
        {TRAVELER_OFFERED_METHODS.map((method) => (
          <button key={method} type="submit" name="method" value={method} className={BUTTON}>{METHOD_LABELS[method]}</button>
        ))}
      </form>
      <p className="mt-5 text-sm text-ink-soft">
        By continuing, you agree to our{config.termsUrl ? <> <a href={config.termsUrl} className="font-bold underline underline-offset-4">Terms of Service</a> and</> : null}{" "}
        <a href={PRIVACY_PATH} className="font-bold underline underline-offset-4">Privacy Notice</a>.
      </p>
      <p className="mt-2 text-sm text-ink-soft">You can still book as a guest without an account.</p>
      <form method="post" action={TRAVELER_START_PATH} className="mt-10 border-t border-line pt-4">
        <button type="submit" className="min-h-10 text-[0.875rem] font-bold text-ink-soft underline underline-offset-4 hover:text-ink">Log in with a NIHO account</button>
      </form>
    </main>
  );
}
