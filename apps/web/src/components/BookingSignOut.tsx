"use client";

import { useState } from "react";
import { signOutOfBooking } from "@/lib/guest-booking-page";
import { Notice, buttonClass } from "./ui";

/**
 * "Sign out on this device" on the guest's booking page (#285 slice 6): a same-origin POST that ends this device's
 * session for the booking and removes its cookie, then shows the page without the booking.
 */
export function BookingSignOut({ publicBookingId }: { publicBookingId: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await signOutOfBooking(publicBookingId);
    if (ok) {
      window.location.replace(window.location.pathname);
      return;
    }
    setBusy(false);
    setFailed(true);
  }

  return (
    <div>
      {failed ? (
        <div role="alert" className="mb-4">
          <Notice tone="danger" title="We couldn't sign you out. Please try again." />
        </div>
      ) : null}
      <button type="button" onClick={() => void signOut()} disabled={busy} aria-busy={busy || undefined} className={buttonClass("secondary")}>
        {busy ? "Signing out…" : "Sign out on this device"}
      </button>
    </div>
  );
}
