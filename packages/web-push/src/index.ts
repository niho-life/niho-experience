/**
 * Web Push boundary for the host app (#177 P2): RFC 8291 message encryption, RFC 8292 VAPID and a
 * sender that talks only to the browsers' own push services. node:crypto only. The endpoint is a
 * capability URL: it never appears in an error message.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

export class WebPushError extends Error {
  readonly reason: "INVALID_KEY" | "INVALID_SUBJECT" | "INVALID_OPTIONS" | "PAYLOAD_TOO_LARGE";
  constructor(reason: WebPushError["reason"]) {
    super(`Web Push ${reason}`);
    this.name = "WebPushError";
    this.reason = reason;
  }
}

const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Accepts the padded and unpadded forms; browsers differ. */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(value)) throw new TypeError("Invalid base64url");
  return new Uint8Array(Buffer.from(value.replace(/=+$/, ""), "base64url"));
}

const isPublicKey = (bytes: Uint8Array) => bytes.length === 65 && bytes[0] === 0x04;

function decodeKey(value: string, length: number): Uint8Array<ArrayBuffer> | null {
  try {
    const bytes = fromBase64Url(value);
    return bytes.length === length && (length !== 65 || isPublicKey(bytes)) ? bytes : null;
  } catch {
    return null;
  }
}

export interface PushPayloadInput {
  plaintext: string | Uint8Array;
  /** The subscription's `p256dh`: an uncompressed P-256 point (65 octets). */
  uaPublicKey: Uint8Array;
  /** The subscription's `auth` (16 octets). */
  authSecret: Uint8Array;
  recordSize?: number;
}

/** Fixed inputs for the RFC 8291 example only; real messages use a new key pair and salt each time. */
export interface PushEncryptionTesting {
  asPrivateKey: Uint8Array;
  salt: Uint8Array;
}

const ascii = (text: string) => Buffer.from(text, "latin1");

/**
 * RFC 8291 `aes128gcm` body: one record with the 0x02 delimiter and no padding, after the
 * header salt(16) ‖ rs(uint32) ‖ idlen(1)=65 ‖ as_public(65).
 */
export function encryptPushPayload(input: PushPayloadInput, testing?: PushEncryptionTesting): Uint8Array<ArrayBuffer> {
  const { uaPublicKey, authSecret, recordSize = 4096 } = input;
  if (!isPublicKey(uaPublicKey) || authSecret.length !== 16) throw new WebPushError("INVALID_KEY");
  if (!Number.isInteger(recordSize) || recordSize < 18 || recordSize > 0xffff_ffff) throw new WebPushError("INVALID_OPTIONS");
  const plaintext = typeof input.plaintext === "string" ? Buffer.from(input.plaintext, "utf8") : Buffer.from(input.plaintext);
  // A single record holds the plaintext, the delimiter and the 16-octet tag.
  if (plaintext.length + 1 + 16 > recordSize) throw new WebPushError("PAYLOAD_TOO_LARGE");

  const ecdh = createECDH("prime256v1");
  if (testing) ecdh.setPrivateKey(testing.asPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  let ecdhSecret: Buffer;
  try {
    ecdhSecret = ecdh.computeSecret(uaPublicKey);
  } catch {
    throw new WebPushError("INVALID_KEY");
  }
  const salt = testing ? Buffer.from(testing.salt) : randomBytes(16);
  if (salt.length !== 16) throw new WebPushError("INVALID_OPTIONS");

  const keyInfo = Buffer.concat([ascii("WebPush: info\0"), uaPublicKey, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, ascii("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, ascii("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);
  return new Uint8Array(Buffer.concat([header, ciphertext]));
}

export interface VapidKeys {
  /** `mailto:` or `https:`, so the push service can reach whoever runs the sender. */
  subject: string;
  /** Raw uncompressed P-256 public key, base64url (the browser's applicationServerKey). */
  publicKey: string;
  /** Raw 32-octet private scalar, base64url. Secret Manager only. */
  privateKey: string;
}

/** True when both keys decode to the right sizes and the private key yields the public one. */
export function isVapidKeyPair(publicKey: string, privateKey: string): boolean {
  const pub = decodeKey(publicKey, 65);
  const priv = decodeKey(privateKey, 32);
  if (!pub || !priv) return false;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().equals(Buffer.from(pub));
  } catch {
    return false;
  }
}

export function isVapidSubject(subject: string): boolean {
  try {
    const protocol = new URL(subject).protocol;
    return protocol === "mailto:" || protocol === "https:";
  } catch {
    return false;
  }
}

const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;
const jsonPart = (value: unknown) => toBase64Url(Buffer.from(JSON.stringify(value)));

/** RFC 8292 `Authorization: vapid t=<JWT>, k=<public key>` for one push service (`aud` is the endpoint's origin). */
export function vapidAuthorization({ endpoint, subject, publicKey, privateKey, now }: VapidKeys & { endpoint: string; now: number }): string {
  if (!isVapidSubject(subject)) throw new WebPushError("INVALID_SUBJECT");
  if (!isVapidKeyPair(publicKey, privateKey)) throw new WebPushError("INVALID_KEY");
  let audience: string;
  try {
    audience = new URL(endpoint).origin;
  } catch {
    // URL's own error carries the input; this one does not.
    throw new WebPushError("INVALID_OPTIONS");
  }
  const pub = fromBase64Url(publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: toBase64Url(pub.subarray(1, 33)), y: toBase64Url(pub.subarray(33)), d: toBase64Url(fromBase64Url(privateKey)) },
    format: "jwk",
  });
  const header = jsonPart({ typ: "JWT", alg: "ES256" });
  const claims = jsonPart({ aud: audience, exp: Math.floor(now / 1000) + VAPID_LIFETIME_SECONDS, sub: subject });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${toBase64Url(pub)}`;
}

const PUSH_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const PUSH_HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];
export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

/**
 * The SSRF guard: only the browsers' own push services, over https on the default port, with no
 * credentials, in the form the browser serialises. Anything else is refused before a request is made.
 */
export function isAllowedPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PUSH_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.href !== value || url.protocol !== "https:" || url.username || url.password || url.port !== "" || url.hash) return false;
  const host = url.hostname;
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

export interface PushSubscriptionKeys {
  endpoint: string;
  /** base64url, 65 octets. */
  p256dh: string;
  /** base64url, 16 octets. */
  auth: string;
}

/** Whether stored or submitted keys have the sizes RFC 8291 needs. */
export function isPushSubscriptionKeys(p256dh: string, auth: string): boolean {
  return decodeKey(p256dh, 65) !== null && decodeKey(auth, 16) !== null;
}

export type PushOutcome = "sent" | "gone" | "retry" | "rejected";

export interface SendWebPushInput {
  subscription: PushSubscriptionKeys;
  payload: string;
  vapid: VapidKeys;
  ttlSeconds: number;
  urgency: "high" | "normal";
  /** Replaces an undelivered message with the same topic (base64url characters, at most 32). */
  topic?: string;
  fetch?: typeof fetch;
  now?: number;
}

const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_TTL_SECONDS = 28 * 24 * 60 * 60;
const SEND_TIMEOUT_MS = 10_000;

function outcomeOf(status: number): PushOutcome {
  if (status === 201 || status === 202) return "sent";
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || status >= 500) return "retry";
  return "rejected";
}

/**
 * One message to one subscription. `gone` means the subscription no longer exists; `retry` a busy
 * or unreachable push service; `rejected` anything else, including an endpoint outside the allowlist
 * or unusable keys (no request is made for those). Redirects are not followed.
 */
export async function sendWebPush(input: SendWebPushInput): Promise<{ outcome: PushOutcome; status: number }> {
  const { subscription, topic, ttlSeconds } = input;
  if (topic !== undefined && !TOPIC.test(topic)) throw new WebPushError("INVALID_OPTIONS");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > MAX_TTL_SECONDS) throw new WebPushError("INVALID_OPTIONS");
  if (!isAllowedPushEndpoint(subscription.endpoint)) return { outcome: "rejected", status: 0 };
  const uaPublicKey = decodeKey(subscription.p256dh, 65);
  const authSecret = decodeKey(subscription.auth, 16);
  if (!uaPublicKey || !authSecret) return { outcome: "rejected", status: 0 };

  const body = encryptPushPayload({ plaintext: input.payload, uaPublicKey, authSecret });
  const headers: Record<string, string> = {
    TTL: String(ttlSeconds),
    Urgency: input.urgency,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    Authorization: vapidAuthorization({ ...input.vapid, endpoint: subscription.endpoint, now: input.now ?? Date.now() }),
  };
  if (topic !== undefined) headers.Topic = topic;

  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(subscription.endpoint, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  } catch {
    return { outcome: "retry", status: 0 };
  }
  await response.body?.cancel().catch(() => undefined);
  return { outcome: outcomeOf(response.status), status: response.status };
}

/** A new VAPID key pair, base64url (docs/host-pwa.md). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const scalar = ecdh.getPrivateKey();
  const privateKey = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]);
  return { publicKey: toBase64Url(ecdh.getPublicKey()), privateKey: toBase64Url(privateKey) };
}
