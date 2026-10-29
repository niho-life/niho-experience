import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { EDITOR_SESSION_ABSOLUTE_MAX_AGE_MS, startEditorSession } from "./session";

describe("editor session deadline", () => {
  it("caps the initial session and keeps the original deadline after refresh", () => {
    const now = Date.now();
    const fields = {
      refreshToken: "synthetic-refresh",
      idToken: "synthetic-id",
      idTokenExpiresAt: now + 2 * 60 * 60 * 1000,
      connectionId: "synthetic-connection",
      exchangedConnectionExpiresAt: now + 180 * 24 * 60 * 60 * 1000,
      verifiedConnectionExpiresAt: now + 180 * 24 * 60 * 60 * 1000,
      actorId: "synthetic-writer",
    };
    const first = startEditorSession(fields, now);
    expect(first?.expiresAt).toBe(now + EDITOR_SESSION_ABSOLUTE_MAX_AGE_MS);
    const refreshed = startEditorSession({ ...fields, absoluteExpiresAt: first!.expiresAt }, now + 60 * 60 * 1000);
    expect(refreshed?.expiresAt).toBe(first?.expiresAt);
    expect(startEditorSession({ ...fields, absoluteExpiresAt: first!.expiresAt }, first!.expiresAt)).toBeNull();
  });
});
