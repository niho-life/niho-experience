export function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Operator-configured NIHO support destination; never carry a booking query or token to it. */
export function safeNihoHelpUrl(value: string, nihoWebOrigin: string): string | null {
  const href = safeHttpsUrl(value);
  const origin = safeHttpsUrl(nihoWebOrigin);
  if (!href || !origin) return null;
  const url = new URL(href);
  return url.origin === new URL(origin).origin && !url.search && !url.hash ? href : null;
}

/** Operator-verified legacy provider screen; do not carry untrusted provider or auth values to NIHO. */
export function safeNihoProviderUrl(value: string, nihoWebOrigin: string): string | null {
  try {
    const url = new URL(value);
    const origin = new URL(nihoWebOrigin);
    if (url.origin !== origin.origin || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/experiences/provider") return null;
    return url.href;
  } catch {
    return null;
  }
}
