/** Forward the UI's already-validated request once, without Chromium's network retry. */
export async function forwardSingleWrite(route) {
  let response;
  try {
    response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 10_000 });
  } catch {
    // The source may have saved before the response vanished. Preserve the used
    // permit and let the driver converge through a fresh, independent read.
    return route.abort("failed");
  }
  try { return await route.fulfill({ response }); }
  finally { await response.dispose(); }
}
