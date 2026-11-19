import "server-only";
import { GoogleAuth } from "google-auth-library";
import { config } from "@/lib/config";
import { parseBearerToken } from "@/lib/host/bearer-token";

const serviceAuth = new GoogleAuth();

/** Fixed-audience Google identity for Experience's NIHO server-to-server calls. */
export async function experienceHostServiceIdToken(): Promise<string> {
  const audience = config.nihoExperienceHostCommonContractAudience;
  if (!audience) throw new Error("NIHO Experience service audience is unavailable");
  const client = await serviceAuth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  const token = parseBearerToken(headers.authorization ?? headers.Authorization);
  if (token === null) throw new Error("Experience service identity is unavailable");
  return token;
}
