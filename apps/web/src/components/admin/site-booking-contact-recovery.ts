import type { ExperienceSupportCase } from "@niho-experience/experience-store";

type CaseEvent = ExperienceSupportCase["events"][number];

/** Where the guest's email of a contact is, in the words the Admin reads. */
export const CONTACT_DELIVERY_LABEL: Record<NonNullable<CaseEvent["delivery"]>, string> = {
  PENDING: "メール送信待ち",
  SENDING: "メール送信中",
  SENT: "メール送信済み",
  FAILED: "メール送信に失敗",
};

/** How long after a contact was accepted a screen opened again still reminds the Admin of it. */
export const RECENT_CONTACT_WINDOW_MS = 30 * 60_000;
/** The server's clock may run a little ahead of this browser's. */
const CLOCK_SKEW_MS = 60_000;

/** A reply from a server that does not send the state yet (a deploy in progress) reads as not known, never as a blank. */
export function contactDeliveryText(event: Pick<CaseEvent, "delivery">): string {
  return (event.delivery ? CONTACT_DELIVERY_LABEL[event.delivery] : undefined) ?? "送信状態を確認できません";
}

/**
 * The case as the screen holds it, with only its history taken from a fresh read. The assignee, the memo and the revision
 * stay the screen's own: a draft being typed is not lost, and the revision it will be saved against is not moved past
 * another Admin's change the Admin has not seen. A fresh read that is not a case (none to open) changes nothing.
 */
export function withRefreshedEvents(current: ExperienceSupportCase, fresh: ExperienceSupportCase | null): ExperienceSupportCase {
  return fresh === null ? current : { ...current, events: fresh.events };
}

/**
 * The newest contact this Admin made a short while ago whose email is not known to be sent. A screen opened again
 * has lost the command it held in memory (and the words, which are never kept anywhere in the browser), so this is
 * what tells the Admin the contact was already accepted and must not be sent a second time. A contact that was sent,
 * another Admin's contact and an old one are not reminded of. `events` are newest first.
 */
export function unsettledOwnContact(events: readonly CaseEvent[], adminUserId: string | null, nowMs: number): CaseEvent | null {
  if (adminUserId === null) return null;
  return events.find((event) => {
    if (event.type !== "GUEST_CONTACT_SENT" || event.actorAdminUserId !== adminUserId || event.delivery === "SENT") return false;
    const age = nowMs - Date.parse(event.occurredAtUtc);
    return Number.isFinite(age) && age >= -CLOCK_SKEW_MS && age <= RECENT_CONTACT_WINDOW_MS;
  }) ?? null;
}
