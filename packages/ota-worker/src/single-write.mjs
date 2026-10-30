function sameOriginXhrHeaders(request, expectedPageUrl) {
  const source = new URL(request.frame().url());
  const target = new URL(request.url());
  if (source.href !== expectedPageUrl || source.origin !== target.origin || request.method() !== "POST"
    || request.resourceType() !== "xhr" || request.isNavigationRequest() || request.redirectedFrom()) throw new Error("WRITE_CONTEXT_MISMATCH");
  const entries = Object.entries(request.headers()).map(([key, value]) => [key.toLowerCase(), value]);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("WRITE_CONTEXT_MISMATCH");
  const headers = Object.fromEntries(entries);
  if (headers.origin !== source.origin || (headers.referer && new URL(headers.referer).origin !== source.origin)
    || headers["sec-fetch-user"] !== undefined) throw new Error("WRITE_CONTEXT_MISMATCH");
  // Chromium adds these after Fetch interception. APIRequestContext does not.
  // Derive only the facts proven above: a direct same-origin XMLHttpRequest.
  // XHR uses cors mode; Fetch maps the empty destination to the `empty` token.
  for (const [key, value] of Object.entries({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })) {
    if (headers[key] !== undefined && headers[key] !== value) throw new Error("WRITE_CONTEXT_MISMATCH");
    headers[key] = value;
  }
  return headers;
}

/** Forward the UI's already-validated request once, without Chromium's network retry. */
export async function forwardSingleWrite(route, { sameOriginXhrPage } = {}) {
  let response;
  try {
    const headers = sameOriginXhrPage === undefined ? undefined : sameOriginXhrHeaders(route.request(), sameOriginXhrPage);
    response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 10_000, ...(headers ? { headers } : {}) });
  } catch {
    // The source may have saved before the response vanished. Preserve the used
    // permit and let the driver converge through a fresh, independent read.
    return route.abort("failed");
  }
  try { return await route.fulfill({ response }); }
  finally { await response.dispose(); }
}
