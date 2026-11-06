import "server-only";
import type { ExperienceHostApiClient as SelectedExperienceHostApiClient } from "@niho-experience/api-client/host";
import type { ExperienceHostApiClient as LegacyExperienceHostApiClient, ExperienceProviderConsent } from "@niho-experience/api-client/legacy-host";
import { nihoIdOrNull, selectProvider, type HostProvider } from "@/lib/host/providers";
import { hostApiClient, isHostMock, loadHostProviders, readHostSession, selectedHostApiClient } from "@/lib/host/server";
import { accessTokenUsable, nihoSessionOrNull, type HostSession, type NihoHostSession } from "@/lib/host/session";
import { experiencePublicationRepository } from "@/lib/experience/store-server";
import { openStripe, stepNotice, syncStripe } from "./connect";
import {
  editorExperience,
  googleConnectionPreview,
  hostConsoleSnapshot,
  hostHome,
  reviewList,
  salesList,
  type HostEditorExperience,
  type HostHomeData,
  type HostReviewList,
  type HostSalesList,
} from "./console-data";
import { loadNotificationSettings } from "./notification-settings-server";
import { mockExperienceBookings, mockExperienceThreads } from "./mock/experience-reservations";
import { siteBooking } from "./site-bookings";
import { isSellerPageUrl, type HostNotice, type HostPayoutLoad } from "./payout";
import type { HostExperience, HostGoogleConnection, HostMeetingDefaults, HostPublicationReadiness, HostSettings } from "./types";

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
  /** The Google account 設定 › カレンダー's つなぐ connects in the preview; null in http mode (Google's own consent page, calendar-server.ts). */
  googleConnection: HostGoogleConnection | null;
}

/**
 * The NIHO login's session when its NIHO Web access token can still be sent (the console layout refreshes it otherwise).
 * null for an Experience host account (ADR 0003): it has no NIHO token, so nothing below calls NIHO for it.
 */
async function usableNihoSession(): Promise<NihoHostSession | null> {
  const session = nihoSessionOrNull(await readHostSession());
  return session && accessTokenUsable(session, Date.now()) ? session : null;
}

/**
 * Meeting-point editing belongs to NIHO's legacy provider contract and is not in contract v1.
 * Keep only the synthetic preview; live mode fails closed until E connects the Experience product editor.
 */
async function loadMeetingDefaults(provider: Pick<HostProvider, "id" | "memberRole">, mode: "mock" | "http", synthetic: HostMeetingDefaults): Promise<HostMeetingDefaults | null> {
  if (provider.memberRole !== "OWNER" && provider.memberRole !== "EDITOR") return null;
  return mode === "mock" ? synthetic : null;
}

/** The contract mock retains provider detail/consent for the old preview screens only. */
async function loadMockProviderDetail(provider: HostProvider) {
  const session = await usableNihoSession();
  if (!session || !isHostMock()) return null;
  try {
    const result = await hostApiClient(session).getExperienceProvider(provider.id);
    return result.ok && result.data.provider ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Everything the old console pages show for one seller workspace: the home rows and numbers,
 * the experiences and the settings' starting values. Mock mode returns synthetic sets; http
 * mode does not read a NIHO provider list/detail because Host v1 has no such operation.
 * Seller fields come from the local Experience seller profile. The (client) settings form
 * gets display fields and the Experience provider id; Connect lookup keys and NIHO IDs remain
 * server-side. The notification
 * settings are the owner's only (niho-app spec §17.4); http mode reads them from the experience
 * DB once HOST_NOTIFICATION_SETTINGS_ENABLED is on (#109), and they stay 準備中 until then.
 * Only 設定 asks for them (`notifications`) and for 既定の集合案内 (`meetingPoint`); the other pages
 * read neither the DB nor NIHO for them.
 */
export async function loadHostConsoleData(provider: HostProvider, options: { notifications?: boolean; meetingPoint?: boolean } = {}): Promise<HostConsoleData> {
  const mode = isHostMock() ? "mock" : "http";
  const session = await readHostSession();
  const snapshot = hostConsoleSnapshot(provider.id, mode, Date.now(), session?.mockScenario);
  const legacyDetail = mode === "mock" ? await loadMockProviderDetail(provider) : null;
  const displayProvider = legacyDetail?.provider;
  const owner = provider.memberRole === "OWNER";
  const [meetingPoint, notificationLoad] = await Promise.all([
    options.meetingPoint ? loadMeetingDefaults(provider, mode, snapshot.meetingPoint) : null,
    mode === "http" && owner && session && options.notifications ? loadNotificationSettings(provider) : null,
  ]);
  return {
    today: snapshot.today,
    home: hostHome(mode === "mock" ? { ...snapshot, bookings: mockExperienceBookings(provider.id).map(siteBooking), threads: mockExperienceThreads(provider.id) } : snapshot),
    experiences: snapshot.experiences,
    settings: {
      displayName: displayProvider?.displayName ?? provider.displayName,
      kind: displayProvider?.kind ?? provider.kind ?? null,
      bio: displayProvider?.bio ?? provider.bio ?? "",
      sellerDisclosureUrl: displayProvider ? displayProvider.sellerDisclosureUrl ?? "" : provider.sellerDisclosureUrl ?? "",
      reviewStatus: displayProvider?.reviewStatus ?? provider.reviewStatus ?? null,
      // Host v1 has no provider-terms endpoint. Only the synthetic preview checks its mock consent.
      consentCurrent: displayProvider && legacyDetail ? displayProvider.consentVersion === legacyDetail.consent.version : null,
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
  /** The first publication day used by the mock (YYYY-MM-DD, JST). */
  today: string;
  /** Existing account/provider facts used only by the mock's self-publication controls. */
  publication: HostPublicationReadiness;
}

/** The experience editor's page (#89): the experience with this id and the provider who hosts it. */
export async function loadHostExperienceEditor(provider: HostProvider, id: string): Promise<HostExperienceEditorData> {
  const mock = isHostMock();
  const [data, payout] = await Promise.all([loadHostConsoleData(provider), mock ? loadHostPayout(provider, { candidates: false }) : Promise.resolve(null)]);
  const reviewStatus = data.settings.reviewStatus;
  return {
    editor: editorExperience(data, mock ? "mock" : "http", id),
    host: { name: data.settings.displayName, bio: data.settings.bio },
    today: data.today,
    publication: {
      role: provider.memberRole,
      payoutReason: payout?.load.status === "owner" ? payout.load.payout.reason : null,
      sellerDisclosureReady: isSellerPageUrl(data.settings.sellerDisclosureUrl),
      consentCurrent: data.settings.consentCurrent,
      providerStatus: reviewStatus === null ? "unknown" : reviewStatus === "SUSPENDED" ? "suspended" : "available",
    },
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
  client: SelectedExperienceHostApiClient,
  provider: Pick<HostProvider, "id" | "memberRole" | "legacyProviderId">,
): Promise<HostPayoutLoad> {
  if (provider.memberRole !== "OWNER") return { status: "not-owner" };
  try {
    const readiness = await client.getLegacyConnectAccount(provider.legacyProviderId);
    if (!readiness.ok) return { status: "error" };
    if (isHostMock()) return { status: "owner", payout: {
      reason: readiness.data.readiness.reason, sharedFrom: null, candidates: [], reuseConsent: null,
    } };
    const identity = await loadHostProviders();
    if (identity.status !== "ok") return { status: "error" };
    const repository = experiencePublicationRepository();
    if (!repository) return { status: "error" };
    const mapping = await repository.currentOwnerSellerProfile(identity.nihoUserId);
    if (mapping.kind !== "ready" || mapping.profile.providerId !== provider.id || mapping.profile.legacyProviderId !== provider.legacyProviderId) return { status: "error" };
    const reason = readiness.data.stripeAccountId === mapping.profile.stripeConnectAccountRef
      ? readiness.data.readiness.reason
      : "RESTRICTED";
    return {
      status: "owner",
      payout: {
        reason,
        sharedFrom: null,
        candidates: [],
        // The v1 projection returns accepted/version/time, not the old consent text or reuse candidates.
        reuseConsent: null,
      },
    };
  } catch {
    return { status: "error" };
  }
}

/** Legacy payout setup remains available to the synthetic preview; live HTTP uses Host v1 read-only. */
export async function readMockHostPayout(
  client: LegacyExperienceHostApiClient,
  provider: Pick<HostProvider, "id" | "legacyProviderId" | "memberRole" | "paymentReuseSourceSpotId">,
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
  // An Experience host account (ADR 0003) has no NIHO session: NIHO's Connect projection is not read, and 受取口座 reads
  // as unreadable until slice 3 reads the account from Stripe directly.
  const session = await usableNihoSession();
  if (!session) return { load: { status: "error" }, notice: null, redirectTo: null };
  try {
    if (isHostMock()) {
      const client = hostApiClient(session);
      let notice: HostNotice | null = null;
      if (options.connect) {
        const step = options.connect === "return" ? await syncStripe(client, provider.id) : await openStripe(client, provider.id, "resume");
        if (step.kind === "stripe") return { load: { status: "error" }, notice: null, redirectTo: step.url };
        notice = stepNotice(step);
      }
      return { load: await readMockHostPayout(client, provider, options), notice, redirectTo: null };
    }
    const client = await selectedHostApiClient(session, { legacyProviderId: provider.legacyProviderId });
    return { load: await readHostPayout(client, provider), notice: null, redirectTo: null };
  } catch {
    return { load: { status: "error" }, notice: null, redirectTo: null };
  }
}

/** Contract v1 intentionally has no NIHO provider-terms endpoint; synthetic terms are preview-only. */
export async function loadRegistrationConsent(): Promise<ExperienceProviderConsent | null> {
  if (!isHostMock()) return null;
  const session = await usableNihoSession();
  if (!session) return null;
  try {
    const result = await hostApiClient(session).listExperienceProviders();
    return result.ok ? result.data.consent : null;
  } catch {
    return null;
  }
}
