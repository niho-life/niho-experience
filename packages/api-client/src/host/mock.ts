/**
 * ホスト API の合成データの fetch（プレビュー・テスト専用）。NIHO の提供者 API と同じ path・status・本文の形を返し、
 * 同じ契約の検証を通す。実在の提供者・口座・連絡先は入れず、決済・DB・ログインは持たない。
 *
 * 登録・紹介の変更・審査の申請・口座の再利用・Stripe の接続・集合場所・体験ページ（作成・保存・公開・公開停止・削除）・
 * 体験サイトへの掲載（申請・取り下げ）・写真の上げ口は、同じ fetch のインスタンスの中でだけ状態を変える
 * （インスタンスを作り直すと scenario の最初の状態に戻る）。Stripe の接続の `url` と写真の URL は実在しない host を指す。
 * 失敗の本文は契約の `ExperienceHostErrorResponse`（400 以外は合成の `supportId` / `requestId` を持つ）。
 */
import type { FetchLike } from "../client.ts";
import {
  createMockErrors,
  createMockPageRoutes,
  EMPTY_MEETING_POINT,
  jsonResponse,
  MOCK_KITCHEN_MEETING_POINT,
  seedKitchenPages,
  type MockPageOwner,
} from "./mock-pages.ts";
import type {
  ExperienceProvider,
  ExperienceProviderConsent,
  ExperienceProviderKind,
  ExperienceProviderMemberRole,
  ExperienceProviderPaymentReadinessReason,
  ExperienceProviderWithMemberRole,
  ExperienceHostErrorReason,
} from "./types.ts";

export { isMockPhotoUrl, MOCK_LISTING_CONSENT } from "./mock-pages.ts";

export const MOCK_HOST_SCENARIOS = ["empty", "two-providers", "payments-pending", "cohost"] as const;
/**
 * - `empty`: 提供者が 0 件（登録の入口）。
 * - `two-providers`: OWNER で審査が承認済み・口座が準備済みの「サンプルの台所」（申込があるので口座は切り替えられない）と、
 *   EDITOR で下書きの「サンプル工房」。台所には集合場所の既定と体験ページが 2 件ある（英語で公開中・体験サイトに掲載中の
 *   「Cook a seasonal home meal together (sample)」と、日本語の下書きで表紙・料金・曜日が足りない「（サンプル）朝市で買って、台所で作る」）。
 * - `payments-pending`: OWNER で下書き・口座が未接続の「サンプルの庭」。再利用の候補に、準備済みの拠点と本人確認待ちの拠点がある。
 *   体験ページは 0 件で、集合場所は未設定。
 * - `cohost`: `two-providers` と同じ合成ページを、日常運営だけを担う COHOST として開く。
 */
export type MockHostScenario = (typeof MOCK_HOST_SCENARIOS)[number];

export type MockExperienceHostFetchOptions = {
  /** 既定は `two-providers`。 */
  scenario?: MockHostScenario;
  /** 時刻の基準（既定は呼び出し時の現在時刻）。test で固定する。 */
  now?: () => Date;
  /** 写真の保存が止まっている状態にする（写真の上げ口が 503 `uploads_disabled`）。既定は false。 */
  uploadsDisabled?: boolean;
};

/** mock のログイン中の本人（合成）。 */
export const MOCK_HOST_USER = { id: "sample-user", displayName: "サンプル ホスト" } as const;

export const MOCK_PROVIDER_CONSENT: ExperienceProviderConsent = {
  version: "sample-provider-consent-1",
  text: "（サンプル）提供者として登録し、NIHO の提供者規約に同意します。この文言は合成データです。",
};

export const MOCK_PAYMENT_REUSE_CONSENT: ExperienceProviderConsent = {
  version: "sample-payment-reuse-consent-1",
  text: "（サンプル）拠点の販売者口座を、体験の売上の受取に使うことに同意します。この文言は合成データです。",
};

/** mock の Stripe の接続が返す遷移先。実在しない host で、画面はこれを検出して自前の mock 画面へ切り替える。 */
const MOCK_CONNECT_ORIGIN = "https://connect.stripe.test";
const MOCK_CONNECT_FRAGMENT = "#niho-mock-connect";
const CONNECT_LINK_TTL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isMockConnectUrl(url: string): boolean {
  return url.startsWith(`${MOCK_CONNECT_ORIGIN}/`) && url.endsWith(MOCK_CONNECT_FRAGMENT);
}

type MockProvider = MockPageOwner & {
  memberRole: ExperienceProviderMemberRole;
  /** Stripe の口座がある（start で作る）。 */
  connected: boolean;
  /** 申込がある（口座を切り替えられない）。 */
  hasBookings: boolean;
};

/** 体験ページ・集合場所・写真の無い提供者の、mock の状態。 */
function pageOwner(provider: ExperienceProvider): Omit<MockPageOwner, "provider" | "readiness"> {
  return { vesselSlug: provider.id.replace(/^sample-provider-/, "sample-"), meetingPoint: { ...EMPTY_MEETING_POINT }, pages: [], photos: new Set() };
}

type MockSpot = { id: string; name: string; reason: ExperienceProviderPaymentReadinessReason };

function iso(date: Date, offsetMs = 0): string {
  return new Date(date.getTime() + offsetMs).toISOString();
}

function seedProvider(
  base: Date,
  fields: { id: string; kind: ExperienceProviderKind; displayName: string; bio: string; sellerDisclosureUrl: string | null; ownerUserId: string; createdDaysAgo: number },
): ExperienceProvider {
  const createdAt = iso(base, -fields.createdDaysAgo * DAY_MS);
  return {
    id: fields.id,
    ownerUserId: fields.ownerUserId,
    vesselSpotId: `${fields.id}-vessel`,
    kind: fields.kind,
    displayName: fields.displayName,
    bio: fields.bio,
    sellerDisclosureUrl: fields.sellerDisclosureUrl,
    reviewStatus: "DRAFT",
    consentVersion: MOCK_PROVIDER_CONSENT.version,
    consentedAt: createdAt,
    submittedAt: null,
    approvedAt: null,
    paymentReuseConsentVersion: null,
    paymentReuseConsentedAt: null,
    paymentReuseSourceSpotId: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function seed(scenario: MockHostScenario, base: Date): { providers: MockProvider[]; spots: MockSpot[] } {
  if (scenario === "empty") return { providers: [], spots: [] };
  if (scenario === "payments-pending") {
    const garden = seedProvider(base, {
      id: "sample-provider-garden",
      kind: "INDIVIDUAL",
      displayName: "サンプルの庭",
      bio: "庭の手入れを一緒にする体験の、合成データの提供者です（sample）。",
      sellerDisclosureUrl: "https://example.com/sample-garden/legal",
      ownerUserId: MOCK_HOST_USER.id,
      createdDaysAgo: 3,
    });
    return {
      providers: [
        {
          provider: garden,
          ...pageOwner(garden),
          memberRole: "OWNER",
          readiness: "NOT_CONNECTED",
          connected: false,
          hasBookings: false,
        },
      ],
      spots: [
        { id: "sample-spot-house", name: "サンプルの拠点", reason: "READY" },
        { id: "sample-spot-annex", name: "サンプルの別館", reason: "VERIFICATION_REQUIRED" },
      ],
    };
  }
  const kitchen = seedProvider(base, {
    id: "sample-provider-kitchen",
    kind: "INDIVIDUAL",
    displayName: "サンプルの台所",
    bio: "家庭料理を一緒に作る体験の、合成データの提供者です（sample）。",
    sellerDisclosureUrl: "https://example.com/sample-kitchen/legal",
    ownerUserId: MOCK_HOST_USER.id,
    createdDaysAgo: 40,
  });
  const studio = seedProvider(base, {
    id: "sample-provider-studio",
    kind: "BUSINESS",
    displayName: "サンプル工房",
    bio: "器づくりの体験の、合成データの提供者です（sample）。",
    sellerDisclosureUrl: null,
    ownerUserId: "sample-user-studio-owner",
    createdDaysAgo: 10,
  });
  const kitchenOwner = pageOwner(kitchen);
  const kitchenPages = seedKitchenPages(base, { vesselSpotId: kitchen.vesselSpotId, vesselSlug: kitchenOwner.vesselSlug }, MOCK_HOST_USER.id);
  return {
    providers: [
      {
        provider: { ...kitchen, reviewStatus: "APPROVED", submittedAt: iso(base, -35 * DAY_MS), approvedAt: iso(base, -33 * DAY_MS), updatedAt: iso(base, -33 * DAY_MS) },
        ...kitchenOwner,
        meetingPoint: { ...MOCK_KITCHEN_MEETING_POINT },
        pages: kitchenPages.pages,
        photos: new Set(kitchenPages.photos),
        memberRole: scenario === "cohost" ? "COHOST" : "OWNER",
        readiness: "READY",
        connected: true,
        hasBookings: true,
      },
      { provider: studio, ...pageOwner(studio), memberRole: "EDITOR", readiness: "NOT_CONNECTED", connected: false, hasBookings: false },
    ],
    spots: [],
  };
}

const json = jsonResponse;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROFILE_FIELDS = ["displayName", "bio", "sellerDisclosureUrl"] as const;
const REGISTER_FIELDS = [...PROFILE_FIELDS, "kind", "consentVersion"] as const;

function hasOnly(body: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(body).every((key) => fields.includes(key));
}

function isDisclosureUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

type ProfileFields = { displayName?: string; bio?: string; sellerDisclosureUrl?: string | null };

/** NIHO の検証と同じ（前後の空白を除いてから長さを見る）。不正なら null。 */
function readProfile(body: Record<string, unknown>): ProfileFields | null {
  const profile: ProfileFields = {};
  if ("displayName" in body) {
    if (typeof body.displayName !== "string") return null;
    const displayName = body.displayName.trim();
    if (displayName.length < 1 || displayName.length > 100) return null;
    profile.displayName = displayName;
  }
  if ("bio" in body) {
    if (typeof body.bio !== "string") return null;
    const bio = body.bio.trim();
    if (bio.length > 4000) return null;
    profile.bio = bio;
  }
  if ("sellerDisclosureUrl" in body) {
    if (!isDisclosureUrl(body.sellerDisclosureUrl)) return null;
    profile.sellerDisclosureUrl = body.sellerDisclosureUrl;
  }
  return profile;
}

export function createMockExperienceHostFetch(options: MockExperienceHostFetchOptions = {}): FetchLike {
  const scenario = options.scenario ?? "two-providers";
  const now = options.now ?? (() => new Date());
  const state = seed(scenario, now());
  let registered = 0;
  let connectLinks = 0;
  const errors = createMockErrors();
  const pageRoutes = createMockPageRoutes({ now, errors, hostUser: MOCK_HOST_USER, uploadsDisabled: options.uploadsDisabled ?? false });
  const unauthorized = () => errors.fail(401, "UNAUTHORIZED");
  const notFound = (reason?: ExperienceHostErrorReason) => errors.fail(404, "NOT_FOUND", reason ? { reason } : {});
  const invalid = () => errors.badRequest();
  const conflict = (reason: ExperienceHostErrorReason) => errors.fail(409, "CONFLICT", { reason });
  const unprocessable = (reason: ExperienceHostErrorReason) => errors.fail(422, "UNPROCESSABLE_ENTITY", { reason });

  const withRole = (entry: MockProvider): ExperienceProviderWithMemberRole => ({ ...entry.provider, memberRole: entry.memberRole });
  const find = (providerId: string) => state.providers.find((entry) => entry.provider.id === providerId);
  const consents = { consent: MOCK_PROVIDER_CONSENT, paymentReuseConsent: MOCK_PAYMENT_REUSE_CONSENT };

  function update(entry: MockProvider, fields: Partial<ExperienceProvider>): void {
    entry.provider = { ...entry.provider, ...fields, updatedAt: now().toISOString() };
  }

  function register(body: unknown): Response {
    if (!isObject(body) || !hasOnly(body, REGISTER_FIELDS) || !REGISTER_FIELDS.every((field) => field in body)) return invalid();
    const profile = readProfile(body);
    if (!profile || (body.kind !== "INDIVIDUAL" && body.kind !== "BUSINESS")) return invalid();
    if (typeof body.consentVersion !== "string" || body.consentVersion.length > 100) return invalid();
    if (body.consentVersion !== MOCK_PROVIDER_CONSENT.version) return unprocessable("PROVIDER_CONSENT_OUTDATED");
    registered += 1;
    const at = now().toISOString();
    const id = `sample-provider-new-${registered}`;
    const provider: ExperienceProvider = {
      id,
      ownerUserId: MOCK_HOST_USER.id,
      vesselSpotId: `${id}-vessel`,
      kind: body.kind,
      displayName: profile.displayName ?? "",
      bio: profile.bio ?? "",
      sellerDisclosureUrl: profile.sellerDisclosureUrl ?? null,
      reviewStatus: "DRAFT",
      consentVersion: body.consentVersion,
      consentedAt: at,
      submittedAt: null,
      approvedAt: null,
      paymentReuseConsentVersion: null,
      paymentReuseConsentedAt: null,
      paymentReuseSourceSpotId: null,
      createdAt: at,
      updatedAt: at,
    };
    state.providers.push({ provider, ...pageOwner(provider), memberRole: "OWNER", readiness: "NOT_CONNECTED", connected: false, hasBookings: false });
    return json(201, { provider, ...consents });
  }

  function patch(entry: MockProvider, body: unknown): Response {
    if (!isObject(body) || Object.keys(body).length === 0 || !hasOnly(body, PROFILE_FIELDS)) return invalid();
    const profile = readProfile(body);
    if (!profile) return invalid();
    if ("sellerDisclosureUrl" in profile && entry.memberRole !== "OWNER") return errors.fail(403, "FORBIDDEN");
    const reviewStatus = entry.provider.reviewStatus === "APPROVED" || entry.provider.reviewStatus === "SUSPENDED" ? "REQUESTED" : entry.provider.reviewStatus;
    update(entry, { ...profile, reviewStatus });
    return json(200, { provider: entry.provider });
  }

  function submit(entry: MockProvider): Response {
    const { reviewStatus, sellerDisclosureUrl, consentVersion } = entry.provider;
    const submittable = (reviewStatus === "DRAFT" || reviewStatus === "REQUESTED") &&
      sellerDisclosureUrl?.startsWith("https://") === true && consentVersion === MOCK_PROVIDER_CONSENT.version;
    if (!submittable) return conflict("PROVIDER_REVIEW_STATE_CONFLICT");
    update(entry, { reviewStatus: "REQUESTED", submittedAt: now().toISOString() });
    return json(200, { submitted: true });
  }

  function reuse(entry: MockProvider, body: unknown): Response {
    if (!isObject(body) || !hasOnly(body, ["sourceSpotId", "consentVersion"])) return invalid();
    const { sourceSpotId, consentVersion } = body;
    if (typeof sourceSpotId !== "string" || sourceSpotId.length < 1 || sourceSpotId.length > 200) return invalid();
    if (typeof consentVersion !== "string" || consentVersion.length > 100) return invalid();
    // NIHO と同じ順: 同意の版 → 申込の有無 → 拠点の OWNER か → 拠点の口座の準備
    if (consentVersion !== MOCK_PAYMENT_REUSE_CONSENT.version) return unprocessable("PROVIDER_PAYMENT_CONSENT_OUTDATED");
    if (entry.hasBookings) return conflict("PROVIDER_PAYMENT_LOCKED");
    const spot = state.spots.find((candidate) => candidate.id === sourceSpotId);
    if (!spot) return notFound("PROVIDER_PAYMENT_SOURCE_FORBIDDEN");
    if (spot.reason !== "READY") return unprocessable("PROVIDER_PAYMENT_SOURCE_NOT_READY");
    const at = now().toISOString();
    update(entry, { paymentReuseConsentVersion: consentVersion, paymentReuseConsentedAt: at, paymentReuseSourceSpotId: spot.id });
    entry.readiness = "READY";
    return json(200, { provider: entry.provider });
  }

  function connect(entry: MockProvider, action: "start" | "resume" | "sync"): Response {
    if (entry.provider.paymentReuseSourceSpotId) return conflict("PROVIDER_PAYMENT_SHARED_ACCOUNT");
    if (action === "sync") {
      if (!entry.connected) return conflict("PROVIDER_PAYMENT_NOT_CONNECTED");
      // 本人が Stripe の画面を済ませた想定で、本人確認待ちを準備済みにする。
      if (entry.readiness === "VERIFICATION_REQUIRED") entry.readiness = "READY";
      return json(200, { url: null, expiresAt: null, ready: entry.readiness === "READY", reason: entry.readiness });
    }
    if (!entry.connected) {
      if (entry.hasBookings) return conflict("PROVIDER_PAYMENT_LOCKED");
      entry.connected = true;
      entry.readiness = "VERIFICATION_REQUIRED";
    }
    connectLinks += 1;
    return json(200, {
      url: `${MOCK_CONNECT_ORIGIN}/setup/${encodeURIComponent(entry.provider.id)}/${connectLinks}${MOCK_CONNECT_FRAGMENT}`,
      expiresAt: iso(now(), CONNECT_LINK_TTL_MS),
      ready: entry.readiness === "READY",
      reason: entry.readiness,
    });
  }

  async function route(request: Request): Promise<Response> {
    const authorization = request.headers.get("authorization") ?? "";
    if (!/^Bearer \S+$/.test(authorization)) return unauthorized();
    const method = request.method.toUpperCase();
    let segments: string[];
    try {
      segments = new URL(request.url).pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    } catch {
      return notFound();
    }
    const readBody = async (): Promise<unknown> => {
      try {
        return JSON.parse(await request.text()) as unknown;
      } catch {
        return null;
      }
    };

    if (segments.join("/") === "api/auth/me") {
      return method === "GET" ? json(200, { user: { ...MOCK_HOST_USER }, userIconImage: null }) : notFound();
    }
    if (segments[0] !== "api" || segments[1] !== "experience-providers") return notFound();
    const [providerId, ...rest] = segments.slice(2);
    const tail = rest.join("/");

    if (providerId === undefined) {
      if (method === "GET") return json(200, { providers: state.providers.map(withRole), platformAdmin: false, ...consents });
      if (method === "POST") return register(await readBody());
      return notFound();
    }
    const entry = find(providerId);
    // 所属していない・存在しない提供者は区別せず 404。OWNER だけの操作は EDITOR にも 404。
    if (!entry) return notFound();
    if (tail === "" && method === "GET") return json(200, { provider: withRole(entry), platformAdmin: false, ...consents });
    if (tail === "" && method === "PATCH") return patch(entry, await readBody());
    // 集合場所・体験ページ・写真は OWNER / EDITOR / COHOST（掲載同意だけ OWNER）
    const pageResponse = await pageRoutes.route(entry, entry.memberRole === "OWNER", method, rest, request, readBody);
    if (pageResponse) return pageResponse;
    if (entry.memberRole !== "OWNER") return notFound();
    if (tail === "submit" && method === "POST") return submit(entry);
    if (tail === "payments/readiness" && method === "GET") {
      return json(200, { ready: entry.readiness === "READY", reason: entry.readiness, paymentReuseConsent: MOCK_PAYMENT_REUSE_CONSENT });
    }
    if (tail === "payments/reuse-candidates" && method === "GET") {
      const spots = state.spots.map((spot) => ({ id: spot.id, name: spot.name, ready: spot.reason === "READY", reason: spot.reason }));
      return json(200, { spots, paymentReuseConsent: MOCK_PAYMENT_REUSE_CONSENT });
    }
    if (tail === "payments/reuse" && method === "POST") return reuse(entry, await readBody());
    if (tail === "payments/connect/start" && method === "POST") return connect(entry, "start");
    if (tail === "payments/connect/resume" && method === "POST") return connect(entry, "resume");
    if (tail === "payments/connect/sync" && method === "POST") return connect(entry, "sync");
    return notFound();
  }

  return async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return route(new Request(input, init));
  };
}
