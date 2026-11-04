import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkoutIpDigest } from "./checkout-ip-limit.ts";

const KEY = "a-key-with-at-least-thirty-two-bytes";
const EXPECTED = createHmac("sha256", KEY).update("experience-checkout-ip:v1\0").update("2001:db8::1").digest("hex");

describe("public checkout client IP", () => {
  it("uses only the trusted edge client IP and stores a keyed digest", () => {
    const request = new Request("https://experience.example/checkout", {
      headers: {
        "cf-connecting-ip": "2001:db8::1",
        "cf-ray": "0123456789abcdef-NRT",
        "x-forwarded-for": "198.51.100.200, 192.0.2.10",
      },
    });
    expect(checkoutIpDigest(request, KEY)).toBe(EXPECTED);
    expect(checkoutIpDigest(request, KEY)).not.toContain("2001:db8::1");
  });

  it("ignores spoofable forwarded headers and refuses invalid or absent edge identity", () => {
    const spoofOnly = new Request("https://experience.example/checkout", {
      headers: { "x-forwarded-for": "203.0.113.8" },
    });
    const malformed = new Request("https://experience.example/checkout", {
      headers: { "cf-connecting-ip": "203.0.113.8", "cf-ray": "not-a-cloudflare-ray" },
    });
    expect(checkoutIpDigest(spoofOnly, KEY)).toBeNull();
    expect(checkoutIpDigest(malformed, KEY)).toBeNull();
    expect(checkoutIpDigest(new Request("https://experience.example/checkout", {
      headers: { "cf-connecting-ip": "203.0.113.8", "cf-ray": "0123456789abcdef-NRT" },
    }), "short")).toBeNull();
  });
});
