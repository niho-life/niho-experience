/** Read the single opaque token from an HTTP Bearer authorization value. */
export function parseBearerToken(value: unknown): string | null {
  if (typeof value !== "string" || !/^Bearer [^\s]+$/.test(value)) return null;
  return value.slice("Bearer ".length);
}
