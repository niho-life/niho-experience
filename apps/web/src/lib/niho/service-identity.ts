import "server-only";
import { GoogleAuth } from "google-auth-library";
import { config } from "@/lib/config";
import { parseBearerToken } from "@/lib/host/bearer-token";

const serviceAuth = new GoogleAuth();

async function serviceIdTokenForAudience(audience: string | undefined, label: string): Promise<string> {
  if (!audience) throw new Error(`${label} service audience is unavailable`);
  const client = await serviceAuth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  const token = parseBearerToken(headers.authorization ?? headers.Authorization);
  if (token === null) throw new Error(`${label} service identity is unavailable`);
  return token;
}

/** Fixed-audience Google identity for Experience's NIHO Host API calls. */
export function experienceHostServiceIdToken(): Promise<string> {
  return serviceIdTokenForAudience(config.nihoExperienceHostCommonContractAudience, "NIHO Experience");
}

/** Separate fixed-audience Google identity for NIHO Login code exchange. */
export function experienceNihoLoginServiceIdToken(): Promise<string> {
  return serviceIdTokenForAudience(config.nihoLoginServiceAudience, "NIHO Login");
}
