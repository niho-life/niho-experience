import { createHash } from "node:crypto";

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/** Google Calendar event IDs use base32hex rather than arbitrary SHA-256 hex. */
export function sha256Base32Hex(value: string): string {
  const digest = createHash("sha256").update(value).digest();
  let bits = 0;
  let accumulator = 0;
  let encoded = "";
  for (const byte of digest) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32HEX[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += BASE32HEX[(accumulator << (5 - bits)) & 31];
  return encoded;
}
