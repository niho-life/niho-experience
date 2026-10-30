import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./google-connection", () => ({ googleRuntimeConfig: () => null }));

import { acceptResourceGoogleWatch } from "./resource-google";

const originalEnabled = process.env.EXPERIENCE_RESOURCE_GOOGLE_ENABLED;
const originalWatch = process.env.EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED;
const originalUrl = process.env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL;
beforeAll(() => {
  process.env.EXPERIENCE_RESOURCE_GOOGLE_ENABLED = "true";
  process.env.EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED = "true";
  process.env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL = "https://experience.example/api/google/calendar/watch";
});
afterAll(() => {
  if (originalEnabled === undefined) delete process.env.EXPERIENCE_RESOURCE_GOOGLE_ENABLED; else process.env.EXPERIENCE_RESOURCE_GOOGLE_ENABLED = originalEnabled;
  if (originalWatch === undefined) delete process.env.EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED; else process.env.EXPERIENCE_RESOURCE_GOOGLE_WATCH_ENABLED = originalWatch;
  if (originalUrl === undefined) delete process.env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL; else process.env.EXPERIENCE_RESOURCE_GOOGLE_WEBHOOK_URL = originalUrl;
});

const token = "synthetic-watch-token-which-is-long-enough";
const headers = (overrides: Record<string, string> = {}) => new Headers({
  "x-goog-channel-id": "00000000-0000-4000-8000-000000000123",
  "x-goog-resource-id": "google-resource-1", "x-goog-channel-token": token, "x-goog-message-number": "8", ...overrides,
});

function fakePool(options: { expired?: boolean; last?: string; current?: boolean } = {}) {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("SELECT * FROM resource_google_watch_channels")) return { rows: [{
        provider_id: "provider-a", resource_id: "room-a", google_resource_id: "google-resource-1",
        token_digest: createHash("sha256").update(token).digest("hex"), expires_at: new Date(Date.now() + (options.expired ? -1 : 60_000)),
        last_message_number: options.last ?? "7", connection_generation: "3", settings_version: "4",
      }] };
      if (sql.startsWith("UPDATE resource_google_calendars")) return { rowCount: options.current === false ? 0 : 1 };
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client }, calls };
}

describe("resource Google watch notification", () => {
  it("rejects forged tokens and expired channels without dirtying inventory", async () => {
    const forged = fakePool();
    expect(await acceptResourceGoogleWatch(forged.pool as never, headers({ "x-goog-channel-token": "f".repeat(40) }))).toBe(false);
    expect(forged.calls.some((sql) => sql.startsWith("UPDATE resource_google_calendars"))).toBe(false);
    const expired = fakePool({ expired: true });
    expect(await acceptResourceGoogleWatch(expired.pool as never, headers())).toBe(false);
  });

  it("accepts a duplicate monotonically but does not create another dirty transition", async () => {
    const duplicate = fakePool({ last: "8" });
    expect(await acceptResourceGoogleWatch(duplicate.pool as never, headers())).toBe(true);
    expect(duplicate.calls.some((sql) => sql.startsWith("UPDATE resource_google_calendars"))).toBe(false);
  });

  it("refuses an old generation/settings epoch and dirties only the current one", async () => {
    const old = fakePool({ current: false });
    expect(await acceptResourceGoogleWatch(old.pool as never, headers())).toBe(false);
    expect(old.calls.some((sql) => sql.startsWith("UPDATE resource_google_watch_channels"))).toBe(false);
    const current = fakePool();
    expect(await acceptResourceGoogleWatch(current.pool as never, headers())).toBe(true);
    expect(current.calls.some((sql) => sql.startsWith("UPDATE resource_google_watch_channels"))).toBe(true);
  });
});
