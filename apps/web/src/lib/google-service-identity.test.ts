import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { verifyGoogleServiceIdentity, type GoogleServiceTokenVerifier } from "./google-service-identity";

const AUDIENCE = "synthetic-audience";
const EMAIL = "runtime@example-project.iam.gserviceaccount.com";
const request = { headers: new Headers({ authorization: "Bearer signed.google.token" }) };

function verifier(claims: Record<string, unknown>): GoogleServiceTokenVerifier {
  return { verify: vi.fn(async () => ({ ok: true as const, claims: claims as never })) };
}

describe("verifyGoogleServiceIdentity", () => {
  it("requires a Google issuer, exact audience, verified allowlisted email, and a live expiry", async () => {
    const valid = { iss: "https://accounts.google.com", aud: AUDIENCE, email: EMAIL, emailVerified: true, exp: Math.floor(Date.now() / 1000) + 300 };
    await expect(verifyGoogleServiceIdentity(request, { audience: AUDIENCE, serviceAccountEmails: [EMAIL] }, verifier(valid))).resolves.toEqual({ ok: true });
    for (const patch of [
      { iss: "https://issuer.invalid" }, { aud: "other" }, { email: "other@example-project.iam.gserviceaccount.com" },
      { emailVerified: false }, { exp: Math.floor(Date.now() / 1000) - 1 },
    ]) {
      await expect(verifyGoogleServiceIdentity(request, { audience: AUDIENCE, serviceAccountEmails: [EMAIL] }, verifier({ ...valid, ...patch })))
        .resolves.toEqual({ ok: false, kind: "invalid" });
    }
  });

  it("does not accept cookies or ordinary bearer formats as service identity", async () => {
    const verify = vi.fn();
    await expect(verifyGoogleServiceIdentity({ headers: new Headers({ cookie: "session=browser" }) }, { audience: AUDIENCE, serviceAccountEmails: [EMAIL] }, { verify }))
      .resolves.toEqual({ ok: false, kind: "missing" });
    expect(verify).not.toHaveBeenCalled();
  });
});
