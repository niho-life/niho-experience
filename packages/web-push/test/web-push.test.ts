import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { describe, it } from "node:test";
import {
  encryptPushPayload,
  fromBase64Url,
  generateVapidKeys,
  isAllowedPushEndpoint,
  isVapidKeyPair,
  sendWebPush,
  toBase64Url,
  vapidAuthorization,
  WebPushError,
  type SendWebPushInput,
} from "../src/index.ts";

const b64 = (value: string) => fromBase64Url(value.replace(/\s+/g, ""));

/** RFC 8291 §5 and Appendix A. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  authSecret: b64("BTBZMqHH6r4Tts7J_aSIgg"),
  uaPublic: b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
  asPrivate: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
  salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
  header: b64("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8"),
  ciphertext: b64("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ"),
  body: b64(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  ),
};

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/synthetic-subscription";

describe("RFC 8291 message encryption", () => {
  it("reproduces the RFC's example byte for byte", () => {
    const body = encryptPushPayload({ plaintext: RFC.plaintext, uaPublicKey: RFC.uaPublic, authSecret: RFC.authSecret }, { asPrivateKey: RFC.asPrivate, salt: RFC.salt });
    // 86-octet header + 41 + 1 + 16. (§5's "Content-Length: 145" disagrees with its own body, which is 144 octets.)
    assert.equal(RFC.body.length, 144);
    assert.equal(body.length, 144);
    assert.deepEqual(Buffer.from(body.subarray(0, 86)), Buffer.from(RFC.header.subarray(0, 86)));
    assert.deepEqual(Buffer.from(body.subarray(86)), Buffer.from(RFC.ciphertext));
    assert.deepEqual(Buffer.from(body), Buffer.from(RFC.body));
  });

  it("uses a new key pair and salt for every message", () => {
    const input = { plaintext: RFC.plaintext, uaPublicKey: RFC.uaPublic, authSecret: RFC.authSecret };
    assert.notDeepEqual(Buffer.from(encryptPushPayload(input)), Buffer.from(encryptPushPayload(input)));
  });

  it("refuses bad keys and a payload larger than one record", () => {
    assert.throws(() => encryptPushPayload({ plaintext: "x", uaPublicKey: RFC.uaPublic.subarray(1), authSecret: RFC.authSecret }), WebPushError);
    assert.throws(() => encryptPushPayload({ plaintext: "x", uaPublicKey: RFC.uaPublic, authSecret: RFC.authSecret.subarray(1) }), WebPushError);
    assert.throws(() => encryptPushPayload({ plaintext: "x".repeat(4096), uaPublicKey: RFC.uaPublic, authSecret: RFC.authSecret }), (error: unknown) => error instanceof WebPushError && error.reason === "PAYLOAD_TOO_LARGE");
  });
});

describe("RFC 8292 VAPID", () => {
  const keys = generateVapidKeys();
  const now = Date.UTC(2026, 9, 28, 3, 0, 0);

  it("signs a 12-hour ES256 token for the push service's origin", () => {
    assert.ok(isVapidKeyPair(keys.publicKey, keys.privateKey));
    const header = vapidAuthorization({ endpoint: ENDPOINT, subject: "mailto:host-push@example.test", ...keys, now });
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    assert.ok(match);
    const [, head, claims, signature, k] = match;
    assert.equal(k, keys.publicKey);
    assert.deepEqual(JSON.parse(Buffer.from(head!, "base64url").toString()), { typ: "JWT", alg: "ES256" });
    assert.deepEqual(JSON.parse(Buffer.from(claims!, "base64url").toString()), { aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 60 * 60, sub: "mailto:host-push@example.test" });
    const pub = fromBase64Url(keys.publicKey);
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: toBase64Url(pub.subarray(1, 33)), y: toBase64Url(pub.subarray(33)) }, format: "jwk" });
    assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, fromBase64Url(signature!)));
  });

  it("refuses a subject that is not mailto: or https:, and keys that do not belong together", () => {
    assert.throws(() => vapidAuthorization({ endpoint: ENDPOINT, subject: "http://example.test", ...keys, now }), (error: unknown) => error instanceof WebPushError && error.reason === "INVALID_SUBJECT");
    const other = generateVapidKeys();
    assert.equal(isVapidKeyPair(keys.publicKey, other.privateKey), false);
    assert.throws(() => vapidAuthorization({ endpoint: ENDPOINT, subject: "https://experience.example.test", publicKey: keys.publicKey, privateKey: other.privateKey, now }), WebPushError);
  });
});

describe("push endpoint allowlist", () => {
  it("accepts the browsers' push services", () => {
    for (const endpoint of [
      ENDPOINT,
      "https://updates.push.services.mozilla.com/wpush/v2/synthetic",
      "https://web.push.apple.com/QSynthetic",
      "https://api.push.apple.com/3/device/synthetic",
      "https://wns2-par02p.notify.windows.com/w/?token=synthetic",
    ]) assert.ok(isAllowedPushEndpoint(endpoint), endpoint);
  });

  it("refuses everything else", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.example/fcm/send/x",
      "https://evil.example/fcm.googleapis.com",
      "https://user:pass@fcm.googleapis.com/fcm/send/x",
      "https://user@fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://fcm.googleapis.com./fcm/send/x",
      "https://169.254.169.254/latest",
      "https://[::1]/x",
      "https://10.0.0.1/x",
      "https://push.apple.com/x",
      "https://notify.windows.com/x",
      "https://xpush.apple.com/x",
      "https://FCM.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com/fcm/send/x#frag",
      ` ${ENDPOINT}`,
      `${ENDPOINT}/${"x".repeat(2048)}`,
      "",
      "not a url",
    ]) assert.equal(isAllowedPushEndpoint(endpoint), false, endpoint);
    assert.equal(isAllowedPushEndpoint(undefined), false);
  });
});

describe("sendWebPush", () => {
  const vapid = { subject: "mailto:host-push@example.test", ...generateVapidKeys() };
  const subscription = { endpoint: ENDPOINT, p256dh: toBase64Url(RFC.uaPublic), auth: toBase64Url(RFC.authSecret) };

  function input(respond: (url: string, init: RequestInit) => Response | Promise<Response>, overrides: Partial<SendWebPushInput> = {}): SendWebPushInput & { calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    return {
      subscription, payload: JSON.stringify({ v: 1, title: "synthetic" }), vapid, ttlSeconds: 60, urgency: "high",
      fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return respond(String(url), init ?? {}); },
      ...overrides, calls,
    };
  }

  it("posts an encrypted body with the push headers, without following redirects", async () => {
    const request = input(() => new Response(null, { status: 201 }), { topic: "booking_1" });
    assert.deepEqual(await sendWebPush(request), { outcome: "sent", status: 201 });
    const [call] = request.calls;
    assert.equal(call?.url, ENDPOINT);
    assert.equal(call?.init.redirect, "manual");
    const headers = new Headers(call?.init.headers);
    assert.equal(headers.get("ttl"), "60");
    assert.equal(headers.get("urgency"), "high");
    assert.equal(headers.get("topic"), "booking_1");
    assert.equal(headers.get("content-encoding"), "aes128gcm");
    assert.equal(headers.get("content-type"), "application/octet-stream");
    assert.match(headers.get("authorization") ?? "", /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    assert.equal((call?.init.body as Uint8Array).length, 86 + Buffer.byteLength(JSON.stringify({ v: 1, title: "synthetic" })) + 17);
  });

  it("maps the push service's answer", async () => {
    const outcome = async (status: number) => (await sendWebPush(input(() => new Response(null, { status })))).outcome;
    assert.equal(await outcome(202), "sent");
    assert.equal(await outcome(404), "gone");
    assert.equal(await outcome(410), "gone");
    assert.equal(await outcome(429), "retry");
    assert.equal(await outcome(503), "retry");
    assert.equal(await outcome(400), "rejected");
    assert.equal(await outcome(413), "rejected");
    assert.equal(await outcome(301), "rejected");
    assert.deepEqual(await sendWebPush(input(() => Promise.reject(new TypeError("network down")))), { outcome: "retry", status: 0 });
  });

  it("makes no request to an endpoint outside the allowlist or with unusable keys", async () => {
    const outside = input(() => new Response(null, { status: 201 }), { subscription: { ...subscription, endpoint: "https://169.254.169.254/latest/meta-data" } });
    assert.deepEqual(await sendWebPush(outside), { outcome: "rejected", status: 0 });
    const badKeys = input(() => new Response(null, { status: 201 }), { subscription: { ...subscription, auth: "short" } });
    assert.deepEqual(await sendWebPush(badKeys), { outcome: "rejected", status: 0 });
    assert.equal(outside.calls.length + badKeys.calls.length, 0);
  });

  it("refuses a topic outside the base64url alphabet and keeps the endpoint out of errors", async () => {
    await assert.rejects(() => sendWebPush(input(() => new Response(null, { status: 201 }), { topic: "booking 1" })), WebPushError);
    await assert.rejects(
      () => sendWebPush(input(() => new Response(null, { status: 201 }), { vapid: { ...vapid, subject: "ftp://x" } })),
      (error: unknown) => error instanceof WebPushError && !error.message.includes(ENDPOINT),
    );
    assert.throws(() => vapidAuthorization({ ...vapid, endpoint: "secret capability url", now: 0 }), (error: unknown) => error instanceof WebPushError && !error.message.includes("secret"));
  });
});
