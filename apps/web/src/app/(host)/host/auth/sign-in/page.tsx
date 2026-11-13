import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { HOST_ACCOUNT_LIMITS } from "@niho-experience/experience-store";
import { hostButtonClass, HOST_HEADING } from "@/components/host/host-ui";
import { config } from "@/lib/config";
import { HostLoginLink } from "@/components/host/HostAppWindow";
import { HOST_EMAIL_LOGIN_PATH, HOST_EMAIL_SIGN_IN_PATH, HOST_HOME_PATH, HOST_INTRO_PATH, HOST_LOGIN_PATH, hostReturnPathOrNull, withQuery } from "@/lib/host/routes";
import { readHostSession, requireHostConsole } from "@/lib/host/server";

export const metadata: Metadata = { title: "ログイン", robots: { index: false, follow: false } };

const ERRORS = {
  email: "メールアドレスの形を確かめて、もう一度入力してください。",
  unavailable: "いまはリンクを送れません。時間をおいて、もう一度お試しください。",
} as const;

/**
 * ホストのログイン (ADR 0003, EXPERIENCE_HOST_ACCOUNTS_ENABLED): the email form every 「ログイン」 link leads to
 * (/host/auth/login sends hosts here), and after it 「メールを確認してください」 (`?sent=1`), which says the same whether
 * or not the address has an account. The form posts without JavaScript; nothing about the address is kept in a URL.
 *
 * A sensitive change that needs a recent sign-in (設定 › 受取口座, ADR 0003 slice 3) sends the host here with `reauth=1`
 * and `next` (an allowlisted page, hostReturnPathOrNull): the form is shown even to a signed-in host, says why, and the
 * opened link returns to that page.
 *
 * With the NIHO account login (EXPERIENCE_HOST_NIHO_LOGIN_ENABLED, Epic #591) this page is the host's entrance: a heading
 * and one button, 「NIHO アカウントでログイン」, and nothing else (no explanation, no email link, no 「体験の提供について」).
 * The email form stays behind `?method=email` (and for a sign-in a sensitive change asked for, `reauth=1`), reached by
 * address only: the migration fallback until #598 removes it.
 */
export default async function HostEmailSignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireHostConsole();
  const query = await searchParams;
  const next = hostReturnPathOrNull(query.next);
  const reauth = query.reauth === "1" && next !== null;
  const sent = query.sent === "1";
  const error = query.error === "email" || query.error === "unavailable" ? ERRORS[query.error] : null;
  if (config.hostNihoLoginEnabled && query.method !== "email" && !reauth && !sent && !error) {
    // A signed-in host goes on to the page they came for; anyone else gets the one button.
    if (await readHostSession()) redirect(next ?? HOST_HOME_PATH);
    return (
      <main id="main" className="mx-auto w-full max-w-xl px-4 py-16">
        <h1 className={`${HOST_HEADING} text-2xl`}>ホストのログイン</h1>
        <div className="mt-8">
          {/* A plain link: login is a route handler, and /host belongs to the traveler site's root. */}
          <HostLoginLink href={withQuery(HOST_LOGIN_PATH, { returnTo: next })} className={hostButtonClass("primary", "w-full justify-center sm:w-auto")}>NIHO アカウントでログイン</HostLoginLink>
        </div>
      </main>
    );
  }
  if (!config.hostAccountsEnabled) notFound();
  // The 「メールを確認してください」 and error states stay here even for a signed-in host (a recent sign-in was asked for,
  // or the form needs fixing); otherwise a signed-in host goes on to the page it came for.
  if (!reauth && !sent && !error && await readHostSession()) redirect(next ?? HOST_HOME_PATH);
  /** This form again, with the page it returns to and why a sign-in was asked for. */
  // With the NIHO account login the email form is behind `method=email`: "send it again" must stay on the form, not fall to the entrance.
  const again = withQuery(HOST_EMAIL_SIGN_IN_PATH, { method: config.hostNihoLoginEnabled ? "email" : null, reauth: reauth ? "1" : null, next });
  const minutes = HOST_ACCOUNT_LIMITS.linkTtlMinutes;

  if (sent) {
    return (
      <main id="main" className="mx-auto w-full max-w-xl px-4 py-16">
        <h1 className={`${HOST_HEADING} text-2xl`}>メールを確認してください</h1>
        <p role="status" className="mt-3 text-ink-soft">
          登録されているアドレスであれば、ログインのリンクをお送りしました。1 分ほどで届きます。
        </p>
        <ul className="mt-4 list-disc space-y-1.5 pl-5 text-ink-soft">
          <li>リンクは {minutes} 分間、1 回だけ使えます。</li>
          <li>リンクは、このブラウザで開いてください。ほかのブラウザやメールのアプリの中で開くと、ログインできません。</li>
          <li>届かないときは、迷惑メールのフォルダも確かめてください。続けて送る場合は 30 秒ほど空けてください。</li>
        </ul>
        <div className="mt-8 flex flex-wrap gap-3">
          <a href={again} className={hostButtonClass("secondary")}>もう一度送る</a>
          <a href={HOST_INTRO_PATH} className={hostButtonClass("secondary")}>体験の提供について</a>
        </div>
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto w-full max-w-xl px-4 py-16">
      <h1 className={`${HOST_HEADING} text-2xl`}>ホストのログイン</h1>
      <p className="mt-3 text-ink-soft">登録しているメールアドレスに、ログインのリンクをお送りします。パスワードはありません。</p>
      {reauth ? (
        <p role="status" className="mt-4 rounded-xl bg-info-pale p-3 text-ink">
          {next?.includes("section=account")
            ? <>NIHO アカウントの結び付けと解除には、{HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes} 分以内のログインが必要です。もう一度ログインしてください。リンクを開くと、設定の「ログイン情報」に戻ります。</>
            : <>受取口座の同意と取り消しには、{HOST_ACCOUNT_LIMITS.recentAuthenticationMinutes} 分以内のログインが必要です。もう一度ログインしてください。リンクを開くと、設定の「受取口座」に戻ります。</>}
        </p>
      ) : null}
      {error ? <p role="alert" className="mt-4 rounded-xl bg-warn-pale p-3 text-warn">{error}</p> : null}
      {/* A plain form: the route answers with a redirect, and the page works without JavaScript. */}
      <form method="post" action={HOST_EMAIL_LOGIN_PATH} className="mt-6 grid gap-4" data-niho-navigation-form>
        {next ? <input type="hidden" name="next" value={next} /> : null}
        {reauth ? <input type="hidden" name="reauth" value="1" /> : null}
        <label className="grid gap-1.5 font-bold">
          メールアドレス
          <input
            type="email"
            name="email"
            required
            maxLength={254}
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            className="min-h-12 w-full rounded-xl border border-line-strong bg-canvas px-3 font-normal"
          />
        </label>
        <button type="submit" className={hostButtonClass("primary", "w-full justify-center sm:w-auto")}>ログインのリンクを送る</button>
      </form>
      <p className="mt-4 text-sm text-muted">リンクは {minutes} 分間、このブラウザでだけ使えます。</p>
      <p className="mt-8"><a href={HOST_INTRO_PATH} className="text-[0.875rem] font-bold text-ink-soft underline underline-offset-4 hover:text-ink">体験の提供について</a></p>
    </main>
  );
}
