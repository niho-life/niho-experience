"use client";

import { useEffect, useRef, useState } from "react";
import { grantFromFragment, openBookingFromGrant } from "@/lib/guest-booking-page";
import { FindBookingForm } from "./FindBookingForm";
import { buttonClass } from "./ui";

type View =
  | { kind: "reading" }
  | { kind: "ready" }
  | { kind: "opening" }
  /** Unknown, expired or already used: the page does not say which. */
  | { kind: "closed" }
  | { kind: "failed" };

/**
 * `/bookings/open` (#285 slice 6, docs/guest-booking.md). The emails link to `/bookings/open#g=<grant>`: the grant is read
 * from the fragment, taken out of the address bar at once and kept in memory only. Nothing about the booking is shown or
 * fetched until the guest presses the button (a link scanner that runs the page opens nothing); then the grant is posted
 * to this site, which sets the booking's HttpOnly cookie, and the page goes to the booking.
 */
export function BookingOpen() {
  const grant = useRef<string | null>(null);
  const [view, setView] = useState<View>({ kind: "reading" });

  useEffect(() => {
    // The grant leaves the address bar before anything else: not in history, a bookmark or a shared screenshot.
    grant.current = grantFromFragment(window.location.hash) ?? grant.current;
    if (window.location.hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    setView({ kind: grant.current ? "ready" : "closed" });
  }, []);

  async function open() {
    if (!grant.current || view.kind === "opening") return;
    setView({ kind: "opening" });
    const result = await openBookingFromGrant(grant.current);
    if (result.kind === "open") {
      grant.current = null;
      // A full load, so the server renders the booking with its new cookie; Back does not return here.
      window.location.replace(result.path);
      return;
    }
    if (result.kind === "closed") grant.current = null;
    setView({ kind: result.kind });
  }

  if (view.kind === "reading") {
    return (
      <div className="container-page max-w-2xl py-12" aria-busy="true">
        <p role="status" className="text-ink-soft">Opening…</p>
      </div>
    );
  }

  if (view.kind === "closed") {
    return (
      <div className="container-page max-w-2xl py-12">
        <p className="hand text-[1.75rem]">this link has closed</p>
        <h1 className="mt-1 text-3xl">This link can&apos;t be used any more</h1>
        <p className="mt-3 text-ink-soft">
          Each link in our emails opens your booking once, for a limited time. We can email you a new one: enter the address you booked with.
        </p>
        <h2 className="mt-8 font-sans text-sm font-extrabold tracking-[0.04em] text-muted uppercase">Send me a new link</h2>
        <FindBookingForm submitLabel="Send me a new link" />
      </div>
    );
  }

  const failed = view.kind === "failed";
  return (
    <div className="container-page max-w-2xl py-12">
      <p className="hand text-[1.75rem]">{failed ? "something went wrong" : "your booking"}</p>
      <h1 className="mt-1 text-3xl">{failed ? "We couldn't open your booking" : "Open your booking"}</h1>
      <p className="mt-3 text-ink-soft">
        {failed
          ? "Please try again in a moment. Your link still works."
          : "This opens your booking on this device. The link in your email works once; you can ask for a new one any time."}
      </p>
      <button
        type="button"
        onClick={() => void open()}
        disabled={view.kind === "opening"}
        aria-busy={view.kind === "opening" || undefined}
        className={buttonClass("primary", "mt-6 w-full sm:w-auto")}
      >
        {view.kind === "opening" ? "Opening…" : failed ? "Try again" : "Open your booking"}
      </button>
    </div>
  );
}
