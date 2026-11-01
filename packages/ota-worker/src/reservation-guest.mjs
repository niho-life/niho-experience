import { isPlainObject } from "./validation.mjs";

// The guest details a reservation reader may add to a fact (#194, owner decision 2026-11-01). The server's
// contract (packages/experience-store external-reservation-guests.ts) is the source; this is the same allowlist and
// bounds, checked before anything is journaled or sent. A reader adds only what it actually read on the site: a
// field it cannot see is left out, never guessed. Amounts, tickets, cookies and raw responses have no field.
export const PARTY_BANDS = Object.freeze(["ADULT", "SENIOR", "YOUTH", "STUDENT", "CHILD", "INFANT"]);
export const GUEST_KEYS = Object.freeze(["name", "partyBreakdown", "email", "phone", "language", "bookingReference", "notes"]);

const CONTROL = /[\u0000-\u001f\u007f]/;
const NOTES_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const EMAIL = /^[^\s\u0000-\u001f\u007f@]+@[^\s\u0000-\u001f\u007f@]+\.[^\s\u0000-\u001f\u007f@]+$/;
const PHONE = /^\+?[0-9 ().-]+$/;
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const BOOKING_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const text = (value, max, control = CONTROL) => typeof value === "string" && value.length >= 1 && value.length <= max
  && value === value.trim() && !control.test(value);

function validBreakdown(value, seats) {
  if (!Array.isArray(value) || value.length < 1 || value.length > PARTY_BANDS.length) return false;
  const seen = new Set();
  let total = 0;
  for (const entry of value) {
    if (!isPlainObject(entry) || Object.keys(entry).length !== 2 || !PARTY_BANDS.includes(entry.band) || seen.has(entry.band)
      || !Number.isSafeInteger(entry.count) || entry.count < 1 || entry.count > 1000) return false;
    seen.add(entry.band);
    total += entry.count;
  }
  return total === seats;
}

/** Whether `value` is a well-formed guest object for a fact of `seats` (at least one known field, nothing else). */
export function validGuestDetails(value, seats) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !GUEST_KEYS.includes(key))) return false;
  return (value.name === undefined || text(value.name, 200))
    && (value.partyBreakdown === undefined || validBreakdown(value.partyBreakdown, seats))
    && (value.email === undefined || (text(value.email, 254) && value.email.length >= 3 && EMAIL.test(value.email)))
    && (value.phone === undefined || (text(value.phone, 32) && PHONE.test(value.phone)))
    && (value.language === undefined || (text(value.language, 35) && LANGUAGE.test(value.language)))
    && (value.bookingReference === undefined || (text(value.bookingReference, 64) && BOOKING_REFERENCE.test(value.bookingReference)))
    && (value.notes === undefined || text(value.notes, 1000, NOTES_CONTROL));
}
