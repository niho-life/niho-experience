import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { config } from "@/lib/config";
import { TRAVELER_LOGOUT_PATH, TRAVELER_SIGN_IN_PATH } from "@/lib/traveler/paths";
import { readTravelerSession } from "@/lib/traveler/server";

export const metadata: Metadata = { title: "Your account", robots: { index: false, follow: false } };

const BUTTON = "inline-flex min-h-12 items-center justify-center gap-2 rounded-full border-[1.5px] border-ink bg-transparent px-6 text-[1rem] font-bold leading-tight text-ink transition-colors hover:bg-sand";

/**
 * A traveler who is logged in (Epic #591, #597). The account is optional and holds nothing yet: guest bookings, messages and
 * reviews are not tied to it (that is decided apart), so the page says only that they are logged in, and offers to log out.
 */
export default async function TravelerAccountPage() {
  if (!config.travelerAccountsEnabled) notFound();
  if (!await readTravelerSession()) redirect(TRAVELER_SIGN_IN_PATH);
  return (
    <main id="main" className="container-page max-w-md py-10 sm:py-16">
      <h1 className="text-3xl">Your account</h1>
      <p className="mt-3 text-ink-soft">You&rsquo;re logged in.</p>
      <p className="mt-2 text-sm text-ink-soft">Booking as a guest works as it always has, with or without an account.</p>
      <form method="post" action={TRAVELER_LOGOUT_PATH} className="mt-8">
        <button type="submit" className={BUTTON}>Log out</button>
      </form>
    </main>
  );
}
