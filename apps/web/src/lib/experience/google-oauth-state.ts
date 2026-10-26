import "server-only";
import { config } from "@/lib/config";
import { cookieSealer } from "@/lib/host/cookie-seal";

export const GOOGLE_OAUTH_COOKIE = "__Secure-niho_experience_google_oauth";
export const GOOGLE_OAUTH_COOKIE_PATH = "/host/calendar/google";
export const GOOGLE_OAUTH_MAX_AGE = 10 * 60;

export interface GoogleOAuthState {
  state: string;
  verifier: string;
  providerId: string;
  nihoUserId: string;
  expiresAt: number;
}

const sealer = () => cookieSealer(config.hostSessionSecret, "google-calendar-oauth");

export function encodeGoogleOAuthState(value: GoogleOAuthState): string {
  return sealer().seal(value);
}

export function decodeGoogleOAuthState(raw: string | undefined, now: number): GoogleOAuthState | null {
  const value = sealer().open(raw) as Partial<GoogleOAuthState> | null;
  if (!value || typeof value.state !== "string" || typeof value.verifier !== "string" || typeof value.providerId !== "string" || typeof value.nihoUserId !== "string" || typeof value.expiresAt !== "number" || now >= value.expiresAt) return null;
  return value as GoogleOAuthState;
}
