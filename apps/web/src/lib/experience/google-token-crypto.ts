import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function googleTokenKey(): Buffer | null {
  const encoded = process.env.EXPERIENCE_GOOGLE_TOKEN_KEY;
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.byteLength === 32 ? key : null;
}

/** AES-GCM ciphertext is bound to its provider and can be rotated by version. */
export function sealGoogleRefreshToken(key: Buffer, providerId: string, refreshToken: string): string {
  if (key.byteLength !== 32 || !providerId || !refreshToken) throw new TypeError("Invalid Google token encryption input");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`niho-experience-google:${providerId}`));
  const ciphertext = Buffer.concat([cipher.update(refreshToken, "utf8"), cipher.final()]);
  return `v1.${nonce.toString("base64url")}.${ciphertext.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function openGoogleRefreshToken(key: Buffer, providerId: string, sealed: string): string {
  const parts = sealed.split(".");
  const [version, nonce, ciphertext, tag] = parts;
  if (key.byteLength !== 32 || parts.length !== 4 || version !== "v1" || !nonce || !ciphertext || !tag) throw new TypeError("Invalid Google token ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
  decipher.setAAD(Buffer.from(`niho-experience-google:${providerId}`));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}
