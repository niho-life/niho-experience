import type {
  ExperienceProviderMeetingPoint,
  ExperienceProviderPageDetail,
  ExperienceProviderPageMeetingPointMode,
  ExperienceProviderPageMeetingPointUpdateRequest,
  ExperienceProviderPageOffer,
  ExperienceProviderPageOfferPatch,
  ExperienceProviderPagePatchRequest,
} from "@niho-experience/api-client/host";
import { MEETING_POINT_FIELDS, normalizeMeetingPoint } from "@/host/meeting-point";

export type LiveEditorConflict = { path: string; label: string; local: unknown; remote: unknown };
export type LiveEditorMerge = { draft: ExperienceProviderPageDetail; conflicts: LiveEditorConflict[] };
export type ConflictChoice = "local" | "remote";

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const editLines = (value: string): string[] => value.split("\n");
export const normalizedLines = (value: readonly string[]): string[] => value.map((item) => item.trim()).filter(Boolean);

const CONTENT_FIELDS = ["lead", "facts", "highlights", "description", "included", "notIncluded", "notSuitableFor", "knowBeforeYouGo"] as const;
const CONTENT_LABELS = { lead: "短い紹介", facts: "対応言語", highlights: "見どころ", description: "詳しい紹介", included: "含まれるもの", notIncluded: "含まれないもの", notSuitableFor: "参加に向かない方", knowBeforeYouGo: "事前案内" };
const OFFER_FIELDS = [
  "name", "shortDescription", "sortOrder", "isActive", "priceYen", "childPriceYen", "childMinAge", "childMaxAge", "adultRequiredForChild",
  "capacity", "maxPartySize", "minimumParticipants", "weekdays", "startTime", "durationMinutes", "cutoffDays", "closedDates", "cancellationPolicy",
  "acceptanceMode", "spaceScope", "useZone", "bookingQuestions",
] as const satisfies readonly (keyof Omit<ExperienceProviderPageOffer, "id">)[];
const OFFER_LABELS: Record<typeof OFFER_FIELDS[number], string> = { name: "商品名", shortDescription: "紹介", sortOrder: "表示順", isActive: "受付状態", priceYen: "料金", childPriceYen: "子ども料金", childMinAge: "子どもの最低年齢", childMaxAge: "子どもの最高年齢", adultRequiredForChild: "大人の同伴", capacity: "定員", maxPartySize: "1組の最大人数", minimumParticipants: "最少催行人数", weekdays: "開催曜日", startTime: "開始時刻", durationMinutes: "所要時間", cutoffDays: "受付締切", closedDates: "休みの日", cancellationPolicy: "取消条件", acceptanceMode: "予約の受付方法", spaceScope: "利用範囲", useZone: "利用エリア", bookingQuestions: "予約時の質問" };

export function conflictValueText(value: unknown): string {
  if (value === undefined) return "削除済み";
  if (value === null || value === "") return "未設定";
  if (typeof value === "boolean") return value ? "有効" : "無効";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(conflictValueText).join("、") : "なし";
  if (typeof value === "object") {
    if ("mode" in value) return value.mode === "INHERIT" ? "提供者の既定を使う" : `この体験だけ別の場所: ${"meetingPoint" in value ? meetingPlaceText(value.meetingPoint) : "未設定"}`;
    if ("language" in value) return conflictValueText(value.language);
    if ("name" in value) return conflictValueText(value.name);
    if ("photoAlts" in value) return `写真の並び・説明: ${conflictValueText(value.photoAlts)}`;
  }
  return "内容が変更されています";
}

function mergeValue<T>(path: string, label: string, base: T, local: T, remote: T, choice: ConflictChoice, conflicts: LiveEditorConflict[]): T {
  if (equal(local, base)) return remote;
  if (equal(remote, base) || equal(local, remote)) return local;
  conflicts.push({ path, label, local, remote });
  return choice === "local" ? local : remote;
}

function mergeOffers(base: readonly ExperienceProviderPageOffer[], local: readonly ExperienceProviderPageOffer[], remote: readonly ExperienceProviderPageOffer[], choice: ConflictChoice, conflicts: LiveEditorConflict[]): ExperienceProviderPageOffer[] {
  const baseById = new Map(base.map((item) => [item.id, item]));
  const localById = new Map(local.map((item) => [item.id, item]));
  const remoteById = new Map(remote.map((item) => [item.id, item]));
  const ids = [...remote.map((item) => item.id), ...local.map((item) => item.id).filter((id) => !remoteById.has(id))];
  const result: ExperienceProviderPageOffer[] = [];
  for (const id of ids) {
    const original = baseById.get(id); const mine = localById.get(id); const theirs = remoteById.get(id);
    if (!original) { if (theirs) result.push(structuredClone(theirs)); else if (mine) result.push(structuredClone(mine)); continue; }
    if (!mine || !theirs) {
      const remaining = mine ?? theirs;
      if (!remaining) continue;
      if (equal(remaining, original)) continue;
      conflicts.push({ path: `offers.${id}`, label: `商品「${original.name}」の削除`, local: mine, remote: theirs });
      const selected = choice === "local" ? mine : theirs;
      if (selected) result.push(structuredClone(selected));
      continue;
    }
    const merged = { id } as ExperienceProviderPageOffer;
    for (const field of OFFER_FIELDS) {
      (merged as Record<string, unknown>)[field] = mergeValue(`offers.${id}.${field}`, `商品「${original.name}」の${OFFER_LABELS[field]}`, original[field], mine[field], theirs[field], choice, conflicts);
    }
    result.push(merged);
  }
  return result;
}

export function mergeLivePage(base: ExperienceProviderPageDetail, local: ExperienceProviderPageDetail, remote: ExperienceProviderPageDetail, choice: ConflictChoice = "local"): LiveEditorMerge {
  const conflicts: LiveEditorConflict[] = [];
  const draft = structuredClone(remote);
  draft.title = mergeValue("title", "題名", base.title, local.title, remote.title, choice, conflicts);
  draft.language = mergeValue("language", "言語", base.language, local.language, remote.language, choice, conflicts);
  draft.slug = mergeValue("slug", "公開名", base.slug, local.slug, remote.slug, choice, conflicts);
  draft.listOnEntrance = mergeValue("listOnEntrance", "入口への表示", base.listOnEntrance, local.listOnEntrance, remote.listOnEntrance, choice, conflicts);
  for (const field of CONTENT_FIELDS) {
    (draft.content as Record<string, unknown>)[field] = mergeValue(`content.${field}`, CONTENT_LABELS[field], base.content[field], local.content[field], remote.content[field], choice, conflicts);
  }
  const photos = mergeValue(
    "photos", "写真・並び・説明",
    { keys: base.photos.map((photo) => photo.objectKey), photoAlts: base.photoAlts }, { keys: local.photos.map((photo) => photo.objectKey), photoAlts: local.photoAlts }, { keys: remote.photos.map((photo) => photo.objectKey), photoAlts: remote.photoAlts }, choice, conflicts,
  );
  const images = new Map([...base.photos, ...local.photos, ...remote.photos].map((photo) => [photo.objectKey, photo]));
  draft.photos = photos.keys.flatMap((key) => { const photo = images.get(key); return photo ? [structuredClone(photo)] : []; }); draft.photoAlts = [...photos.photoAlts];
  draft.offers = mergeOffers(base.offers, local.offers, remote.offers, choice, conflicts);
  draft.offer = draft.offers[0] ?? null;
  return { draft, conflicts };
}

function offerInput(offer: ExperienceProviderPageOffer): ExperienceProviderPageOfferPatch {
  return {
    id: offer.id, name: offer.name, shortDescription: offer.shortDescription, sortOrder: offer.sortOrder, isActive: offer.isActive,
    priceYen: offer.priceYen, childPriceYen: offer.childPriceYen, childMinAge: offer.childMinAge, childMaxAge: offer.childMaxAge,
    adultRequiredForChild: offer.adultRequiredForChild, capacity: offer.capacity, maxPartySize: offer.maxPartySize,
    minimumParticipants: offer.minimumParticipants, weekdays: [...new Set(offer.weekdays)].sort(), startTime: offer.startTime,
    durationMinutes: offer.durationMinutes, cutoffDays: offer.cutoffDays, closedDates: normalizedLines(offer.closedDates),
    cancellationPolicy: offer.cancellationPolicy, acceptanceMode: offer.acceptanceMode, spaceScope: offer.spaceScope,
    useZone: [...offer.useZone], bookingQuestions: structuredClone(offer.bookingQuestions),
  };
}

export function serializeLivePagePatch(draft: ExperienceProviderPageDetail, base: ExperienceProviderPageDetail): ExperienceProviderPagePatchRequest {
  const patch: ExperienceProviderPagePatchRequest = {};
  if (draft.title !== base.title) patch.title = draft.title;
  if (draft.language !== base.language) patch.language = draft.language;
  if (draft.slug !== base.slug) patch.slug = draft.slug;
  if (draft.listOnEntrance !== base.listOnEntrance) patch.listOnEntrance = draft.listOnEntrance;

  const content: NonNullable<ExperienceProviderPagePatchRequest["content"]> = {};
  if (!equal(draft.content.lead, base.content.lead)) content.lead = draft.content.lead;
  if (!equal(draft.content.facts, base.content.facts)) content.facts = structuredClone(draft.content.facts);
  if (!equal(draft.content.highlights, base.content.highlights)) content.highlights = normalizedLines(draft.content.highlights);
  if (!equal(draft.content.description, base.content.description)) content.description = draft.content.description;
  if (!equal(draft.content.included, base.content.included)) content.included = normalizedLines(draft.content.included);
  if (!equal(draft.content.notIncluded, base.content.notIncluded)) content.notIncluded = normalizedLines(draft.content.notIncluded);
  if (!equal(draft.content.notSuitableFor, base.content.notSuitableFor)) content.notSuitableFor = normalizedLines(draft.content.notSuitableFor);
  if (!equal(draft.content.knowBeforeYouGo, base.content.knowBeforeYouGo)) content.knowBeforeYouGo = normalizedLines(draft.content.knowBeforeYouGo);
  if (Object.keys(content).length) patch.content = content;

  const photoObjectKeys = draft.photos.map((photo) => photo.objectKey);
  const basePhotoObjectKeys = base.photos.map((photo) => photo.objectKey);
  if (!equal(photoObjectKeys, basePhotoObjectKeys) || !equal(draft.photoAlts, base.photoAlts)) {
    patch.photoObjectKeys = photoObjectKeys;
    patch.photoAlts = draft.photoAlts.map((item) => item.trim());
  }
  if (!equal(draft.offers, base.offers)) patch.offers = draft.offers.map(offerInput);
  return patch;
}

/*
 * 写真の並び (#89): `photoObjectKeys` is the display order and its first one is the 表紙, `photoAlts` the same
 * order and count, so a photo and its description always move together. Each helper answers a new draft
 * (the same one when the move changes nothing), and the count stays equal even if the descriptions ran short.
 */
export const LIVE_PHOTO_LIMIT = 20;

const withPhotos = (draft: ExperienceProviderPageDetail, photos: ExperienceProviderPageDetail["photos"], alts: readonly string[]): ExperienceProviderPageDetail => ({ ...draft, photos, photoAlts: photos.map((_, at) => alts[at] ?? "") });

/** Moves the photo at `from` to `to`, the ones between shifting by one. */
export function movePhoto(draft: ExperienceProviderPageDetail, from: number, to: number): ExperienceProviderPageDetail {
  const last = draft.photos.length - 1;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > last || to < 0 || to > last || from === to) return draft;
  const photos = [...draft.photos]; const alts = draft.photos.map((_, at) => draft.photoAlts[at] ?? "");
  photos.splice(to, 0, ...photos.splice(from, 1)); alts.splice(to, 0, ...alts.splice(from, 1));
  return withPhotos(draft, photos, alts);
}

/** 代表写真にする: the photo goes first and the others keep their order. */
export const makeCoverPhoto = (draft: ExperienceProviderPageDetail, index: number): ExperienceProviderPageDetail => movePhoto(draft, index, 0);

/** 外す: only from this page's list (the uploaded file itself is not touched). */
export function removePhoto(draft: ExperienceProviderPageDetail, index: number): ExperienceProviderPageDetail {
  if (!Number.isInteger(index) || index < 0 || index >= draft.photos.length) return draft;
  return withPhotos(draft, draft.photos.filter((_, at) => at !== index), draft.photoAlts.filter((_, at) => at !== index));
}

/** Adds an uploaded photo last (it is the 表紙 only when the page had none), unless the page already has the limit. */
export function appendPhoto(draft: ExperienceProviderPageDetail, photo: ExperienceProviderPageDetail["photos"][number], alt: string): ExperienceProviderPageDetail {
  if (draft.photos.length >= LIVE_PHOTO_LIMIT || draft.photos.some((item) => item.objectKey === photo.objectKey)) return draft;
  return withPhotos(draft, [...draft.photos, photo], [...draft.photoAlts, alt.slice(0, 200)]);
}

/*
 * 集合場所 (#89): the page's own meeting point (`/pages/{pageId}/meeting-point`), not the page
 * content's `meetingPoint`. INHERIT uses the provider's default (設定 › 既定の集合案内); OVERRIDE saves
 * `fields`. With INHERIT `fields` stays as it was (hidden), so choosing OVERRIDE again starts from it.
 */
export type LiveMeeting = { mode: ExperienceProviderPageMeetingPointMode; fields: ExperienceProviderMeetingPoint };

const trimmedMeeting = (fields: ExperienceProviderMeetingPoint): ExperienceProviderMeetingPoint =>
  Object.fromEntries(MEETING_POINT_FIELDS.map((field) => [field, fields[field].trim()])) as ExperienceProviderMeetingPoint;

/** What saving would keep: INHERIT is the provider's default whatever it says now. */
const meetingIntent = (meeting: LiveMeeting) => meeting.mode === "INHERIT" ? { mode: "INHERIT" as const } : { mode: "OVERRIDE" as const, meetingPoint: trimmedMeeting(meeting.fields) };

/** The public line and the address, for the conflict box. */
function meetingPlaceText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "未設定";
  const { overview, address } = value as Partial<ExperienceProviderMeetingPoint>;
  return [overview, address].filter((item): item is string => typeof item === "string" && item !== "").join(" / ") || "未設定";
}

/** `GET …/meeting-point` as the BFF answers it, or null when it is not that shape. */
export function readLiveMeeting(value: unknown): LiveMeeting | null {
  if (typeof value !== "object" || value === null) return null;
  const { mode, meetingPoint } = value as { mode?: unknown; meetingPoint?: unknown };
  if (mode !== "INHERIT" && mode !== "OVERRIDE") return null;
  if (typeof meetingPoint !== "object" || meetingPoint === null || !MEETING_POINT_FIELDS.every((field) => typeof (meetingPoint as Record<string, unknown>)[field] === "string")) return null;
  return { mode, fields: Object.fromEntries(MEETING_POINT_FIELDS.map((field) => [field, (meetingPoint as Record<string, string>)[field]])) as ExperienceProviderMeetingPoint };
}

export const liveMeetingChanged = (draft: LiveMeeting, saved: LiveMeeting): boolean => !equal(meetingIntent(draft), meetingIntent(saved));

/** Why OVERRIDE cannot be saved as it is (the map URL), or null. */
export function liveMeetingProblem(meeting: LiveMeeting): string | null {
  if (meeting.mode === "INHERIT" || normalizeMeetingPoint(meeting.fields)) return null;
  return "集合場所の地図 URL は https:// で始まる URL にしてください。";
}

/** The PUT body: the page version, and the trimmed fields for OVERRIDE. */
export function liveMeetingRequest(meeting: LiveMeeting, expectedUpdatedAt: string): ExperienceProviderPageMeetingPointUpdateRequest {
  return meeting.mode === "INHERIT" ? { mode: "INHERIT", expectedUpdatedAt } : { mode: "OVERRIDE", meetingPoint: trimmedMeeting(meeting.fields), expectedUpdatedAt };
}

/** Like the page's fields: one side's change is taken, a change on both sides is one conflict item 「集合場所」. */
export function mergeLiveMeeting(base: LiveMeeting, local: LiveMeeting, remote: LiveMeeting, choice: ConflictChoice = "local"): { draft: LiveMeeting; conflict: LiveEditorConflict | null } {
  const [mine, theirs, original] = [meetingIntent(local), meetingIntent(remote), meetingIntent(base)];
  if (equal(mine, original)) return { draft: structuredClone(remote), conflict: null };
  if (equal(theirs, original) || equal(mine, theirs)) return { draft: structuredClone(local), conflict: null };
  return { draft: structuredClone(choice === "local" ? local : remote), conflict: { path: "meetingPoint", label: "集合場所", local: mine, remote: theirs } };
}
