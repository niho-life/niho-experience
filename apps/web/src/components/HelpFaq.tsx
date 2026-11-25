export type HelpQuestion = Readonly<{ question: string; answer: string }>;

export const HELP_QUESTIONS: readonly HelpQuestion[] = [
  { question: "Do I need an account?", answer: "No. You book as a guest with your name and email address." },
  { question: "How do I pay?", answer: "By card at checkout. Payments are processed by Stripe, in Japanese yen, tax included." },
  { question: "What language is an experience held in?", answer: "Each experience shows its languages on its card and on its page." },
  { question: "Where do we meet?", answer: "The meeting point arrives by email with your booking." },
  { question: "How far is Kamakura from Tokyo?", answer: "About one hour by train." },
];

/** 日本語のよくある質問（#658）。日本語サイトの文言なので、ここ（apps/web）で持つ。 */
export const HELP_QUESTIONS_JA: readonly HelpQuestion[] = [
  { question: "アカウントは必要ですか？", answer: "いいえ。お名前とメールアドレスだけで、ゲストとして予約できます。" },
  { question: "支払い方法は？", answer: "カードでお支払いいただきます。決済はStripeで、日本円・税込です。" },
  { question: "体験は何語で行われますか？", answer: "対応している言語は、体験ごとのページに載せています。" },
  { question: "どこに集合しますか？", answer: "集合場所は、予約の確認メールでお知らせします。" },
  { question: "東京から鎌倉まではどのくらいですか？", answer: "電車でおよそ1時間です。" },
];

/**
 * Common questions under the help text (#645). `<details>`, so it works without JS and by keyboard. Same width as `HelpViewV1`.
 * The Japanese help page passes its own questions and title (#658); without props this is the English list.
 */
export function HelpFaq({ questions = HELP_QUESTIONS, eyebrow = "good to know", title = "Common questions" }: { questions?: readonly HelpQuestion[]; eyebrow?: string; title?: string } = {}) {
  return <section aria-labelledby="help-faq" className="container-page max-w-2xl pb-12 sm:pb-20">
    <p className="eyebrow">{eyebrow}</p>
    <h2 id="help-faq" className="mt-2 text-2xl sm:text-3xl">{title}</h2>
    <div className="mt-4 border-t border-line">
      {questions.map(({ question, answer }) => <details key={question} className="group border-b border-line">
        <summary className="flex min-h-[3.75rem] cursor-pointer list-none items-center justify-between gap-4 py-3 font-bold [&::-webkit-details-marker]:hidden">
          <span>{question}</span>
          <svg className="ico size-5 shrink-0 transition-transform group-open:rotate-180" viewBox="0 0 24 24" aria-hidden><path d="M7 10l5 5 5-5" /></svg>
        </summary>
        <p className="pb-5 text-ink-soft">{answer}</p>
      </details>)}
    </div>
  </section>;
}
