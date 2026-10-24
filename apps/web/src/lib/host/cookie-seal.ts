import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encrypted, authenticated cookie values for the host console (#86).
 *
 * Format: `v1.<key id>.<base64url(iv | ciphertext | tag)>`, AES-256-GCM with a
 * key derived per purpose by HKDF-SHA256 from HOST_SESSION_SECRET. The version
 * and key id let us rotate keys (comma-separated secrets: the first seals, all
 * open) and change the format later without misreading old cookies.
 */
const FORMAT_VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_SALT = "niho-experience/host-cookie";

export type SealPurpose = "session" | "login" | "admin-preview-session" | "admin-http-login" | "admin-http-session";

interface SealKey {
  id: string;
  key: Buffer;
}

function deriveKey(secret: string, purpose: SealPurpose): SealKey {
  const key = Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, `${purpose}/${FORMAT_VERSION}`, 32));
  const id = createHash("sha256").update("key-id\0").update(key).digest().subarray(0, 6).toString("base64url");
  return { id, key };
}

export function splitSecrets(value: string): string[] {
  return value.split(",").map((secret) => secret.trim()).filter(Boolean);
}

export class CookieSealer {
  private readonly keys: readonly SealKey[];
  private readonly aad: Buffer;

  constructor(secrets: readonly string[], purpose: SealPurpose) {
    if (secrets.length === 0) throw new Error("A host cookie secret is required");
    this.keys = secrets.map((secret) => deriveKey(secret, purpose));
    // A value sealed for one purpose (login) can never be opened as another (session).
    this.aad = Buffer.from(`niho-experience/host-${purpose}/${FORMAT_VERSION}`);
  }

  seal(payload: unknown): string {
    const current = this.keys[0]!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", current.key, iv);
    cipher.setAAD(this.aad);
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return `${FORMAT_VERSION}.${current.id}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")}`;
  }

  /** Returns the payload, or null for anything missing, tampered, from an unknown key or not JSON. */
  open(value: string | undefined | null): unknown {
    if (!value) return null;
    const [version, keyId, data, extra] = value.split(".");
    if (version !== FORMAT_VERSION || !keyId || !data || extra !== undefined) return null;
    const key = this.keys.find((candidate) => candidate.id === keyId);
    if (!key) return null;
    const raw = Buffer.from(data, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key.key, raw.subarray(0, IV_BYTES));
      decipher.setAAD(this.aad);
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      const text = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8");
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
}

const sealers = new Map<string, CookieSealer>();

/** One sealer per secret and purpose; HKDF runs once per server process. */
export function cookieSealer(secret: string, purpose: SealPurpose): CookieSealer {
  const cacheKey = `${purpose}\0${secret}`;
  let sealer = sealers.get(cacheKey);
  if (!sealer) {
    sealer = new CookieSealer(splitSecrets(secret), purpose);
    sealers.set(cacheKey, sealer);
  }
  return sealer;
}
