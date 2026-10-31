/**
 * The one sentence under a traveler's message box when the message is translated for the host (#285, owner decision
 * 2026-10-31, docs/guest-questions.md): shown only where translation is on, and the page decides that on the server and
 * passes a boolean (see lib/translation-notice.ts). The link opens in a new tab so a half-written message, or a reply link
 * whose token lives only in memory, is never lost on the way to the notice.
 */
export const TRANSLATION_NOTICE_TEXT = "Your message is translated into Japanese for the host with an AI service.";

export function TranslationNotice({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[0.8125rem] text-muted ${className}`.trim()}>
      {TRANSLATION_NOTICE_TEXT}{" "}
      <a href="/privacy" target="_blank" rel="noopener noreferrer" className="font-bold underline underline-offset-2 hover:text-ink">
        Privacy<span className="sr-only"> (opens in a new tab)</span>
      </a>
    </p>
  );
}
