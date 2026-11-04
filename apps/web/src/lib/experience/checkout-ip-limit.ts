import { createHmac } from "node:crypto";
import { isIP } from "node:net";

/**
 * The public site is behind Cloudflare. Only its overwritten client-IP header is accepted; X-Forwarded-For
 * is deliberately ignored because clients can supply it. The Cloud Run origin must be locked to the trusted
 * Cloudflare path before guest booking is enabled. The raw address never leaves this function.
 */
export function checkoutIpDigest(request: Request, hmacKey: string): string | null {
  const address = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  const ray = request.headers.get("cf-ray")?.trim() ?? "";
  if (!address || isIP(address) === 0 || !/^[a-f\d]{16,32}-[a-z\d]{3}$/i.test(ray)) return null;
  if (Buffer.byteLength(hmacKey, "utf8") < 32) return null;
  return createHmac("sha256", hmacKey).update("experience-checkout-ip:v1\0").update(address).digest("hex");
}
