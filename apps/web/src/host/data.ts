import "server-only";
import type { ExperienceHostApiClient, ExperienceProviderConsent } from "@niho-experience/api-client/host";
import { nihoIdOrNull, selectProvider, type HostProvider } from "@/lib/host/providers";
import { hostApiClient, isHostMock, loadHostProviders, readHostSession } from "@/lib/host/server";
import { idTokenUsable, type HostSession } from "@/lib/host/session";
import type { BookingExperience, SessionQuery } from "./bookings";
import { openStripe, stepNotice, syncStripe } from "./connect";
import {
  bookingClock,
  bookingList,
  bookingOf,
  bookingThreadOf,
  editorExperience,
  googleConnectionPreview,
  hostConsoleSnapshot,
  hostHome,
  reviewList,
  salesList,
  sessionOf,
  threadList,
  threadOf,
  type HostBookingList,
  type HostBookingLookup,
  type HostEditorExperience,
  type HostHomeData,
  type HostReviewList,
  type HostSalesList,
  type HostSessionLookup,
  type HostThreadList,
  type HostThreadLookup,
} from "./console-data";
import { bookingConversations, type BookingConversation } from "./messages";
import { loadNotificationSettings } from "./notification-settings-server";
import type { HostNotice, HostPayoutLoad } from "./payout";
import type { HostExperience, HostGoogleConnection, HostMeetingDefaults, HostSettings } from "./types";

type SearchParams = Record<string, string | string[] | undefined>;

export interface HostPageContext {
  session: HostSession;
  providers: HostProvider[];
  /** The provider this page shows; null when the account has none yet. */
  provider: HostProvider | null;
  /** `?providerId=` named a provider this account cannot open; `provider` is the first one instead. */
  providerNotFound: boolean;
  /** The URL's own `?providerId=` (when well formed), carried on every link of the page. */
  linkProviderId: string | null;
}

/**
 * The signed-in host and the provider a console page shows. Null while the console
 * layout shows sign-in, refresh or error instead (it reads the same cached list).
 */
export async function hostPageContext(query: SearchParams): Promise<HostPageContext | null> {
  const [load, session] = await Promise.all([loadHostProviders(), readHostSession()]);
  if (load.status !== "ok" || !session) return null;
  const requested = typeof query.providerId === "string" ? query.providerId : null;
  const linkProviderId = nihoIdOrNull(requested);
  const { provider, requestedMissing } = selectProvider(load.providers, linkProviderId);
  return { session, providers: load.providers, provider, providerNotFound: requested !== null && (requestedMissing || !linkProviderId), linkProviderId };
}

export interface HostConsoleData {
  /** YYYY-MM-DD in Japan (the preview's fixed day in mock mode). */
  today: string;
  home: HostHomeData;
  experiences: readonly HostExperience[];
  settings: HostSettings;
  /** The Google account 設定 › カレンダー's つなぐ connects in the preview; null in http mode (not connectable yet). */
  googleConnection: HostGoogleConnection | null;
}

/** The session when its ID token can still be sent (the console layout refreshes it otherwise). */
async function usableSession(): Promise<HostSession | null> {
  const session = await readHostSession();
  return session && idTokenUsable(session, Date.now()) ? session : null;
}

/**
 * `GET /api/experience-providers/:id` through the typed host client (#87): NIHO in http
 * mode, the contract mock in mock mode, with the provider terms in force. Null when it
 * cannot be read or names another provider.
 */
async function loadProviderDetail(providerId: string): Promise<{ provider: HostProvider; consent: ExperienceProviderConsent } | null> {
  const session = await usableSession();
  if (!session) return null;
  try {
    const result = await hostApiClient(session).getExperienceProvider(providerId);
    const detail = result.ok ? result.data.provider : null;
    return result.ok && detail?.id === providerId ? { provider: detail, consent: result.data.consent } : null;
  } catch {
    return null;
  }
}

/**
 * 既定の集合案内 (`GET /api/experience-providers/:id/meeting-point`, OWNER and EDITOR): NIHO's in http
 * mode; the preview keeps its synthetic one on screen (no API). Null when it cannot be read, and for
 * anyone else (NIHO answers them 404).
 */
async function loadMeetingDefaults(provider: Pick<HostProvider, "id" | "memberRole">, mode: "mock" | "http", synthetic: HostMeetingDefaults): Promise<HostMeetingDefaults | null> {
  if (provider.memberRole !== "OWNER" && provider.memberRole !== "EDITOR") return null;
  if (mode === "mock") return synthetic;
  const session = await usableSession();
  if (!session) return null;
  try {
    const result = await hostApiClient(session).getExperienceProviderMeetingPoint(provider.id);
    return result.ok ? result.data.meetingPoint : null;
  } catch {
    return null;
  }
}

/**
 * Everything the console pages show for one provider: the home rows and numbers,
 * the experiences and the settings' starting values. Mock mode returns the synthetic
 * sets; http mode is empty while the host contract has no such API (see console-data.ts).
 * The provider's own fields come from NIHO's provider detail in both modes, falling back
 * to the list. The (client) settings form gets display fields and, for its actions, the
 * provider's id (already in `?providerId=`) and the ids of the owner's spots it may share;
 * never NIHO's other internal ids (the owner's user, the vessel spot). The notification
 * settings are the owner's only (niho-app spec §17.4); http mode reads them from the experience
 * DB once HOST_NOTIFICATION_SETTINGS_ENABLED is on (#109), and they stay 準備中 until then.
 * Only 設定 asks for them (`notifications`); the other pages do not read the DB for them.
 */
export async function loadHostConsoleData(provider: HostProvider, options: { notifications?: boolean } = {}): Promise<HostConsoleData> {
  const mode = isHostMock() ? "mock" : "http";
  const session = await readHostSession();
  const snapshot = hostConsoleSnapshot(provider.id, mode, Date.now(), session?.mockScenario);
  const owner = provider.memberRole === "OWNER";
  const [detail, meetingPoint, notificationLoad] = await Promise.all([
    loadProviderDetail(provider.id),
    loadMeetingDefaults(provider, mode, snapshot.meetingPoint),
    mode === "http" && owner && session && options.notifications ? loadNotificationSettings(provider, session.nihoUserId) : null,
  ]);
  const known = detail?.provider ?? provider;
  return {
    today: snapshot.today,
    home: hostHome(snapshot),
    experiences: snapshot.experiences,
    settings: {
      displayName: known.displayName,
      kind: known.kind,
      bio: known.bio,
      sellerDisclosureUrl: known.sellerDisclosureUrl ?? "",
      reviewStatus: known.reviewStatus,
      // Unknown without the detail: NIHO still checks it when the review is requested.
      consentCurrent: detail ? detail.provider.consentVersion === detail.consent.version : true,
      meetingPoint,
      calendar: snapshot.calendar,
      notifications: !owner ? null : notificationLoad?.status === "live" ? { email: { addresses: [] }, items: notificationLoad.items } : snapshot.notifications,
      notificationSource: mode === "mock" ? "preview" : (notificationLoad?.status ?? "preparing"),
    },
    googleConnection: googleConnectionPreview(mode),
  };
}

export interface HostExperienceEditorData {
  editor: HostEditorExperience;
  /** 迎える人: the provider's name and introduction, as 設定 › 提供者情報 has them. */
  host: { name: string; bio: string };
  /** The day a submission is dated (申請日). */
  today: string;
}

/** The experience editor's page (#89): the experience with this id and the provider who hosts it. */
export async function loadHostExperienceEditor(provider: HostProvider, id: string): Promise<HostExperienceEditorData> {
  const data = await loadHostConsoleData(provider);
  return {
    editor: editorExperience(data, isHostMock() ? "mock" : "http", id),
    host: { name: data.settings.displayName, bio: data.settings.bio },
    today: data.today,
  };
}

export interface HostBookingsData {
  /** The day the list counts from (the preview's fixed day in mock mode). */
  today: string;
  /** The moment actions are dated with (the preview's fixed one in mock mode); null takes the clock. */
  now: string | null;
  list: HostBookingList;
  /** The booking `?booking=` names; null when it names none. */
  requested: HostBookingLookup | null;
  /** The provider's experiences, for the list's select, its headings and its seat counts. */
  experiences: BookingExperience[];
  /** メッセージ: the last message of each booking's thread (#106). */
  conversations: BookingConversation[];
}

/**
 * 予約 (#90): the provider's bookings and the one `?booking=` names: synthetic in mock mode,
 * nothing yet in http mode (the page says 準備中). The client screen gets the experiences'
 * titles and the offers' capacity and length, not their pages.
 */
export async function loadHostBookings(provider: HostProvider, requestedId: string | null): Promise<HostBookingsData> {
  const mode = isHostMock() ? "mock" : "http";
  const snapshot = hostConsoleSnapshot(provider.id, mode, Date.now());
  const threads = threadList(snapshot, mode);
  return {
    today: snapshot.today,
    now: bookingClock(mode),
    list: bookingList(snapshot, mode),
    requested: requestedId ? bookingOf(snapshot, mode, requestedId) : null,
    experiences: snapshot.experiences.map(({ id, title, offers }) => ({ id, title, offers: offers.map(({ id: offerId, capacity, durationMinutes }) => ({ id: offerId, capacity, durationMinutes })) })),
    conversations: threads.status === "ready" ? bookingConversations(threads.threads) : [],
  };
}

export interface HostSessionData {
  /** The moment the session is seen from: whether it has started, and when an action is dated (the preview's fixed one in mock mode). */
  now: string;
  lookup: HostSessionLookup;
  /** The threads of the session's bookings (#106), for their メッセージ. */
  conversations: BookingConversation[];
}

/**
 * この回 (#107): one session's bookings (with the phone the guest gave: only this screen has it),
 * the experience's title, capacity and meeting line, and the bookings' threads. Synthetic in mock
 * mode, nothing yet in http mode (the page says 準備中).
 */
export async function loadHostSession(provider: HostProvider, query: SessionQuery): Promise<HostSessionData> {
  const mode = isHostMock() ? "mock" : "http";
  const snapshot = hostConsoleSnapshot(provider.id, mode, Date.now());
  const lookup = sessionOf(snapshot, mode, query);
  const threads = threadList(snapshot, mode);
  const ids = new Set(lookup.status === "ready" ? lookup.session.bookings.map((booking) => booking.id) : []);
  return {
    now: snapshot.now,
    lookup,
    conversations: threads.status === "ready" ? bookingConversations(threads.threads).filter((conversation) => ids.has(conversation.bookingId)) : [],
  };
}

export interface HostMessagesData {
  /** The day the list counts from, and the moment replies are dated with (the preview's fixed ones in mock mode). */
  today: string;
  now: string;
  list: HostThreadList;
  /** What `?thread=` (or else `?booking=`) names; null when it names none. */
  requested: HostThreadLookup | null;
  /** The provider's experiences' titles, for the rows and the thread's heading. */
  experiences: { id: string; title: string }[];
}

/**
 * メッセージ (#106): the provider's threads and the one `?thread=` or `?booking=` names (an
 * empty one for a booking that has none yet): synthetic in mock mode, nothing yet in http mode
 * (the page says 準備中). The client screen gets the threads and the experiences' titles.
 */
export async function loadHostMessages(provider: HostProvider, requested: { thread: string | null; booking: string | null }): Promise<HostMessagesData> {
  const mode = isHostMock() ? "mock" : "http";
  const snapshot = hostConsoleSnapshot(provider.id, mode, Date.now());
  return {
    today: snapshot.today,
    now: snapshot.now,
    list: threadList(snapshot, mode),
    requested: requested.thread ? threadOf(snapshot, mode, requested.thread) : requested.booking ? bookingThreadOf(snapshot, mode, requested.booking) : null,
    experiences: snapshot.experiences.map(({ id, title }) => ({ id, title })),
  };
}

export interface HostReviewsData {
  /** The moment a reply or a report is dated with (the preview's fixed one in mock mode). */
  now: string;
  list: HostReviewList;
  /** The provider's experiences' titles, for the select and each review's session line. */
  experiences: { id: string; title: string }[];
}

/**
 * レビュー (#108): the provider's reviews, published or still checked by NIHO: synthetic in mock
 * mode, nothing yet in http mode (the page says 準備中). The client screen gets the reviews and the
 * experiences' titles.
 */
export function loadHostReviews(provider: Pick<HostProvider, "id">): HostReviewsData {
  const mode = isHostMock() ? "mock" : "http";
  const snapshot = hostConsoleSnapshot(provider.id, mode, Date.now());
  return {
    now: snapshot.now,
    list: reviewList(snapshot, mode),
    experiences: snapshot.experiences.map(({ id, title }) => ({ id, title })),
  };
}

/** 売上 (#91): the provider's ledger and its months (synthetic in mock mode), or nothing to read yet in http mode. */
export function loadHostSales(provider: Pick<HostProvider, "id">): HostSalesList {
  return salesList(hostConsoleSnapshot(provider.id, isHostMock() ? "mock" : "http", Date.now()));
}

/**
 * The payout account (OWNER only: NIHO answers 404 to anyone else) read with this client. An
 * action reads back with its own client, which sees its own change also in the preview (the
 * contract mock keeps a write within one client). `candidates` (default true) also lists the
 * spots whose ready seller account could be shared, and names a shared one.
 */
export async function readHostPayout(
  client: ExperienceHostApiClient,
  provider: Pick<HostProvider, "id" | "memberRole" | "paymentReuseSourceSpotId">,
  options: { candidates?: boolean } = {},
): Promise<HostPayoutLoad> {
  if (provider.memberRole !== "OWNER") return { status: "not-owner" };
  try {
    const [readiness, candidates] = await Promise.all([
      client.getExperienceProviderPaymentReadiness(provider.id),
      options.candidates === false ? null : client.listExperienceProviderPaymentReuseCandidates(provider.id),
    ]);
    if (!readiness.ok) return { status: "error" };
    const spots = candidates?.ok ? candidates.data.spots : [];
    const sharedId = provider.paymentReuseSourceSpotId;
    return {
      status: "owner",
      payout: {
        reason: readiness.data.reason,
        sharedFrom: sharedId ? (spots.find((spot) => spot.id === sharedId)?.name ?? "拠点") : null,
        candidates: spots.filter((spot) => spot.ready).map(({ id, name }) => ({ id, name })),
        reuseConsent: readiness.data.paymentReuseConsent,
      },
    };
  } catch {
    return { status: "error" };
  }
}

export interface HostPayoutData {
  load: HostPayoutLoad;
  /** What Stripe's way back (`?connect=`) led to. */
  notice: HostNotice | null;
  /** `?connect=refresh`: Stripe's new link to go back to. */
  redirectTo: string | null;
}

/**
 * 売上受取口座 for 設定 and 売上. `connect` is Stripe's way back to 設定 (`?connect=`): `return`
 * reads the state from Stripe again first, `refresh` (the link expired or was used) asks NIHO for
 * a new link to send the host back to Stripe. Only the owner's account is read.
 */
export async function loadHostPayout(provider: HostProvider, options: { candidates?: boolean; connect?: "return" | "refresh" | null } = {}): Promise<HostPayoutData> {
  if (provider.memberRole !== "OWNER") return { load: { status: "not-owner" }, notice: null, redirectTo: null };
  const session = await usableSession();
  if (!session) return { load: { status: "error" }, notice: null, redirectTo: null };
  try {
    const client = hostApiClient(session);
    let notice: HostNotice | null = null;
    if (options.connect) {
      const step = options.connect === "return" ? await syncStripe(client, provider.id) : await openStripe(client, provider.id, "resume");
      if (step.kind === "stripe") return { load: { status: "error" }, notice: null, redirectTo: step.url };
      notice = stepNotice(step);
    }
    return { load: await readHostPayout(client, provider, options), notice, redirectTo: null };
  } catch {
    return { load: { status: "error" }, notice: null, redirectTo: null };
  }
}

/** 提供者の登録: the provider terms in force (NIHO's version and words), or null when NIHO cannot be read. */
export async function loadRegistrationConsent(): Promise<ExperienceProviderConsent | null> {
  const session = await usableSession();
  if (!session) return null;
  try {
    const result = await hostApiClient(session).listExperienceProviders();
    return result.ok ? result.data.consent : null;
  } catch {
    return null;
  }
}
