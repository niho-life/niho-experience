import "server-only";
import { config } from "@/lib/config";
import { Pool } from "pg";
import { ChannelRuntime, ExperienceStore, GuestBookingRepository, GuestQuestionRepository, GuideAdminRepository, GuideRepository, ProductOperatorRepository, ProviderNotificationSettings, type ChannelCapabilities } from "@niho-experience/experience-store";

const globalPool = globalThis as typeof globalThis & { __nihoExperiencePool?: Pool };

/** No database URL means the new calendar stays unavailable during the migration. */
export function experiencePool(): Pool | null {
  const connectionString = process.env.EXPERIENCE_DATABASE_URL;
  if (!connectionString) return null;
  if (!globalPool.__nihoExperiencePool) {
    globalPool.__nihoExperiencePool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
  }
  return globalPool.__nihoExperiencePool;
}

export function experienceStore(): ExperienceStore | null {
  const pool = experiencePool();
  return pool ? new ExperienceStore(pool) : null;
}

export function productOperatorRepository(): ProductOperatorRepository | null {
  if (config.apiMode !== "http") return null;
  const pool = experiencePool();
  return pool ? new ProductOperatorRepository(pool) : null;
}

function supportedChannelAdapters(): Readonly<Record<string, ChannelCapabilities>> {
  const raw = process.env.EXPERIENCE_CHANNEL_SUPPORTED_ADAPTERS;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, ChannelCapabilities> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value) || key.length > 300) return {};
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some((name) => !["canObserve", "canReadReservations", "canClose", "canOpen", "canCreate"].includes(name))) return {};
      if (Object.values(record).some((item) => typeof item !== "boolean")) return {};
      result[key] = record as ChannelCapabilities;
    }
    return result;
  } catch {
    return {};
  }
}

export function googleAirbnbObservationEnabled(): boolean {
  return config.apiMode === "http"
    && process.env.EXPERIENCE_AIRBNB_GOOGLE_DELIVERY_ENABLED === "true"
    && process.env.EXPERIENCE_AIRBNB_GOOGLE_OBSERVATION_ENABLED === "true";
}

export function channelRuntime(): ChannelRuntime | null {
  const pool = experiencePool();
  return pool ? new ChannelRuntime(pool, {
    supportedAdapters: supportedChannelAdapters(),
    googleAirbnbObservationEnabled: googleAirbnbObservationEnabled(),
  }) : null;
}

export function guideRepository(): GuideRepository | null {
  const pool = experiencePool();
  return pool ? new GuideRepository(pool) : null;
}

export function guideAdminRepository(): GuideAdminRepository | null {
  const pool = experiencePool();
  return pool ? new GuideAdminRepository(pool) : null;
}

/** 設定 › 通知 (#109): null until its flag is on and the experience DB is configured. */
export function providerNotificationSettings(): ProviderNotificationSettings | null {
  if (!config.hostNotificationSettingsEnabled) return null;
  const pool = experiencePool();
  return pool ? new ProviderNotificationSettings(pool) : null;
}

/** 予約前の質問 (#105/#106): null until its flag is on and the experience DB is configured. */
export function guestQuestionRepository(): GuestQuestionRepository | null {
  if (!config.guestQuestionsEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestQuestionRepository(pool) : null;
}

/** 旅行者の予約 (#285, docs/guest-booking.md): null until its flag is on and the experience DB is configured. */
export function guestBookingRepository(): GuestBookingRepository | null {
  if (!config.guestBookingEnabled) return null;
  const pool = experiencePool();
  return pool ? new GuestBookingRepository(pool) : null;
}

/**
 * The Stripe webhook's view of 旅行者の予約 (#285 slice 4). A Session this service created can end after the
 * flag is turned off, so releasing its hold needs only the experience DB, like confirming its payment.
 */
export function guestHoldReleases(): Pick<GuestBookingRepository, "releaseGuestHold"> | null {
  const pool = experiencePool();
  return pool ? new GuestBookingRepository(pool) : null;
}
