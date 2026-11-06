/**
 * 合成の開催回（mock 専用）。NIHO と同じく、日本時間の今日から 90 日の曜日の規則で開催回を作る。
 * 残席は日付から決まる擬似的な値にし、満席・残りわずか・締切後を画面で確かめられるようにする。
 */
import type { ExperienceDetail, Occurrence } from "../types.ts";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MOCK_AVAILABILITY_WINDOW_DAYS = 90;

function jstDateString(instantMs: number): string {
  const shifted = new Date(instantMs + JST_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** 日本時間の `date` と `HH:mm` を UTC の瞬間にする。 */
function jstToInstant(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+09:00`);
}

/** `open` は残席を作らない（実在の体験を載せる pilot で、作り物の「残りわずか・満席」を見せないため）。 */
export type MockSeatPolicy = "varied" | "sold-out" | "open";

export function buildMockOccurrences(params: {
  experience: ExperienceDetail;
  now: Date;
  seatPolicy?: MockSeatPolicy;
  /** mock の checkout で押さえた席（`offerId|date` → 人数）。 */
  heldSeats?: ReadonlyMap<string, number>;
}): Occurrence[] {
  const { experience, now } = params;
  const seatPolicy = params.seatPolicy ?? "varied";
  const todayJst = jstDateString(now.getTime());
  const todayStart = Date.parse(`${todayJst}T00:00:00+09:00`);
  const occurrences: Occurrence[] = [];

  experience.offers.forEach((offer, offerIndex) => {
    for (let day = 0; day < MOCK_AVAILABILITY_WINDOW_DAYS; day += 1) {
      const dayStart = todayStart + day * DAY_MS;
      const date = jstDateString(dayStart);
      const weekday = new Date(dayStart + JST_OFFSET_MS).getUTCDay();
      if (!offer.weekdays.includes(weekday)) continue;

      const startMs = jstToInstant(date, offer.startTime);
      const endMs = startMs + offer.durationMinutes * 60_000;
      const pattern = (day * 7 + offerIndex * 3) % 10;
      const used = seatPolicy === "sold-out" ? offer.capacity : seatPolicy === "open" ? 0 : pattern === 0 ? offer.capacity : pattern < 3 ? offer.capacity - 1 : pattern % offer.capacity;
      const held = params.heldSeats?.get(`${offer.id}|${date}`) ?? 0;
      const seatsLeft = Math.max(0, offer.capacity - used - held);

      let reason: Occurrence["reason"] = null;
      if (!experience.booking.checkoutAvailable) reason = "UNAVAILABLE";
      else if (startMs <= now.getTime()) reason = "CUTOFF";
      else if (seatsLeft < offer.minimumParticipants) reason = "FULL";

      occurrences.push({
        offerId: offer.id,
        date,
        startAt: new Date(startMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
        // The mock's only cutoff is the start itself (a past start answers CUTOFF), so it closes when it starts.
        bookingClosesAt: new Date(startMs).toISOString(),
        seatsLeft,
        bookable: reason === null,
        reason,
      });
    }
  });

  return occurrences.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.offerId.localeCompare(b.offerId));
}
