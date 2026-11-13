/*
 * A message to a person on 街の人 (#589): what the form on their page checks before it sends, and what the route checks again.
 * One place, so the page and the server never disagree on what a good message is. The limits are the questions' (the
 * traveler's message is at most 1000 characters, a name 100, an address 254; docs/guest-questions.md「上限」).
 */

export const PERSON_MESSAGE_LIMITS = { messageMinLength: 2, messageMaxLength: 1000, nameMaxLength: 100, emailMaxLength: 254 } as const;

export type PersonMessageField = "message" | "guestName" | "guestEmail";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The first field to fix, or null. Takes what the person typed (the route trims nothing: the store does). */
export function personMessageProblem(input: { message: string; guestName: string; guestEmail: string }): PersonMessageField | null {
  const message = input.message.trim();
  if ([...message].length < PERSON_MESSAGE_LIMITS.messageMinLength || [...message].length > PERSON_MESSAGE_LIMITS.messageMaxLength) return "message";
  const name = input.guestName.trim();
  if (name.length === 0 || [...name].length > PERSON_MESSAGE_LIMITS.nameMaxLength) return "guestName";
  const email = input.guestEmail.trim();
  if (!EMAIL.test(email) || email.length > PERSON_MESSAGE_LIMITS.emailMaxLength) return "guestEmail";
  return null;
}
