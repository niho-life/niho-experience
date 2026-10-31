/**
 * Whether a traveler's English is really translated into Japanese for the host, so the page may say so (docs/guest-questions.md,
 * 「翻訳」). The translation is a step of the mail job, so it needs both settings; the mock never translates (both are false
 * there). The page passes the answer to the browser as a plain boolean: the browser never reads settings.
 */
export function translationNoticeShown(settings: { translationEnabled: boolean; guestMailEnabled: boolean }): boolean {
  return settings.translationEnabled === true && settings.guestMailEnabled === true;
}
