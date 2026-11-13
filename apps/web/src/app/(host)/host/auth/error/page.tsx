import type { Metadata } from "next";
import { HostLoginLink } from "@/components/host/HostAppWindow";
import { hostButtonClass, HOST_HEADING } from "@/components/host/host-ui";
import { HOST_EMAIL_SIGN_IN_PATH, HOST_INTRO_PATH, HOST_LOGIN_PATH, LOGIN_ERROR_REASONS, hostInvitationLoginPath, hostPreparationLoginPath, invitationIdOrNull, preparationCaseIdOrNull, withQuery, type LoginErrorReason } from "@/lib/host/routes";
import { config } from "@/lib/config";
import { requireHostConsole } from "@/lib/host/server";

export const metadata: Metadata = { title: "ログインできませんでした" };

const MESSAGES: Record<LoginErrorReason, string> = {
  expired: "ログインの手続きが時間切れになりました（10 分）。もう一度、最初からお試しください。",
  state: "安全のため、ログインを中断しました。別のタブや古い画面から戻った場合に起こります。もう一度お試しください。",
  denied: "NIHO でログインが取り消されました。続けるには、もう一度ログインしてください。",
  rejected: "NIHO でのログインを確認できませんでした。もう一度お試しください。",
  unavailable: "NIHO に接続できませんでした。時間をおいてもう一度お試しください。",
  link: "このログインのリンクは使えません。リンクは送ってから 15 分間、1 回だけ、リンクをリクエストしたブラウザで使えます。期限が切れたか、すでに使われたか、別のブラウザ（メールのアプリの中のブラウザなど）で開いた場合に起こります。リクエストしたブラウザで、新しいリンクを送ってください。",
  unregistered: "このアカウントは、ホストに登録されていません。",
  suspended: "このホストアカウントは停止されています。運営にお問い合わせください。",
  "invite-expired": "この招待のリンクは、期限が切れたか、新しい招待に置き換えられたため使えません。運営に、新しい招待を依頼してください。",
  "invite-used": "この招待のリンクは、すでに使われています。NIHO アカウントを結び付け済みなら、「NIHO アカウントでログイン」で入れます。",
  "invite-browser": "この招待のリンクは、別のブラウザで開かれています。最初にリンクを開いたブラウザで続けてください。メールのアプリの中のブラウザで開いたときは、そのブラウザで NIHO にログインしてください。",
  "invite-invalid": "この招待は使えません。リンクが正しくないか、期限が切れたか、別のブラウザで開いた場合に起こります。運営に、新しい招待を依頼してください。",
  "invite-in-use": "このアカウントは、すでに別のホストに結び付いているため、この招待には使えません。招待を受けたホストの NIHO アカウントで、もう一度ログインしてください。",
  "invite-has-identity": "この招待のホストアカウントには、すでに別の NIHO アカウントが結び付いています。結び付けた NIHO アカウントでログインしてください。",
  "invite-unavailable": "NIHO でのログインを確認できませんでした。時間をおいて、もう一度お試しください。招待のリンクはまだ使えます。",
  unverified: "NIHO でログインした時刻を確認できませんでした。時間をおいて、もう一度お試しください。",
};

/** The invitation's reasons (Epic #591, #596): what to press next (nothing for a link that cannot be used any more). */
const INVITE_RETRY: Partial<Record<LoginErrorReason, { href: string; label: string }>> = {
  "invite-in-use": { href: withQuery(HOST_LOGIN_PATH, { invite: "1" }), label: "別の NIHO アカウントでやり直す" },
  "invite-used": { href: HOST_LOGIN_PATH, label: "NIHO アカウントでログイン" },
  "invite-has-identity": { href: HOST_LOGIN_PATH, label: "NIHO アカウントでログイン" },
  "invite-unavailable": { href: withQuery(HOST_LOGIN_PATH, { invite: "1" }), label: "もう一度ログイン" },
};

/** NIHO's public support address (the help page uses it too). No account or NIHO user ID is put in the link. */
const SUPPORT_HREF = "mailto:info@niho.life?subject=NIHO%20Experience%20%E3%83%9B%E3%82%B9%E3%83%88";

export default async function HostLoginErrorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireHostConsole();
  const { reason, preparationCaseId: rawPreparationCaseId, invitationId: rawInvitationId } = await searchParams;
  const known = LOGIN_ERROR_REASONS.find((candidate) => candidate === reason) ?? "unavailable";
  // Experience host accounts (ADR 0003): a sign-in that failed for any other reason is told as the store's outage.
  // With the NIHO account login the reasons are NIHO's own (below); with the emailed link only the link's reason is told.
  const message = config.hostAccountsEnabled && !config.hostNihoLoginEnabled && known !== "link" ? "ログインできませんでした。時間をおいてもう一度お試しください。" : MESSAGES[known];
  const preparationCaseId = preparationCaseIdOrNull(rawPreparationCaseId);
  const invitationId = invitationIdOrNull(rawInvitationId);
  const loginHref = invitationId ? hostInvitationLoginPath(invitationId) : preparationCaseId ? hostPreparationLoginPath(preparationCaseId) : HOST_LOGIN_PATH;
  // An emailed link that did not open (the migration fallback) is asked for again on the email form, not at NIHO.
  const retryHref = known === "link" && config.hostNihoLoginEnabled ? withQuery(HOST_EMAIL_SIGN_IN_PATH, { method: "email" }) : loginHref;
  if (known.startsWith("invite-")) {
    const retry = INVITE_RETRY[known];
    return (
      <main id="main" className="mx-auto w-full max-w-xl px-4 py-16">
        <h1 className={`${HOST_HEADING} text-2xl`}>招待を使えませんでした</h1>
        <p role="alert" className="mt-3 text-ink-soft">{MESSAGES[known]}</p>
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
          {retry ? <HostLoginLink href={retry.href} className={hostButtonClass("primary")}>{retry.label}</HostLoginLink> : null}
          <a href={SUPPORT_HREF} className="text-[0.875rem] font-bold text-ink-soft underline underline-offset-4 hover:text-ink">運営に問い合わせる</a>
        </div>
      </main>
    );
  }
  if (known === "unregistered" && config.hostNihoLoginEnabled) {
    // The sign-in worked at NIHO, but no host account is bound to that NIHO account (Epic #591). Nothing of Experience's
    // data was touched. The usual cause is a different method than the one the host was registered with (NIHO does not
    // join LINE, Google and Apple accounts by address), so it says that first, then how to try again and whom to ask.
    return (
      <main id="main" className="mx-auto w-full max-w-xl px-4 py-16">
        <h1 className={`${HOST_HEADING} text-2xl`}>このアカウントは、ホストに登録されていません</h1>
        <div role="note" className="mt-4 rounded-xl bg-warn-pale p-4 text-ink">
          <p className="font-bold">別の方法でログインしていませんか？</p>
          <p className="mt-1 text-ink-soft">ホストの登録に使った NIHO アカウントで、もう一度お試しください。NIHO の画面で「別のアカウントで続ける」を選ぶと、ログインの方法を選び直せます。</p>
        </div>
        {/* Plain links: login is a route handler, and /host belongs to the traveler site's root. */}
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4">
          <HostLoginLink href={loginHref} className={hostButtonClass("primary")}>別の方法でやり直す</HostLoginLink>
          <a href={SUPPORT_HREF} className="text-[0.875rem] font-bold text-ink-soft underline underline-offset-4 hover:text-ink">運営に問い合わせる</a>
        </div>
      </main>
    );
  }
  return (
    <main id="main" className="mx-auto w-full max-w-xl px-4 py-16">
      <h1 className={`${HOST_HEADING} text-2xl`}>ログインできませんでした</h1>
      <p role="alert" className="mt-3 text-ink-soft">{message}</p>
      {/* Plain links: login is a route handler, and /host belongs to the traveler site's root. */}
      <div className="mt-8 flex flex-wrap gap-3">
        <HostLoginLink href={retryHref} className={hostButtonClass("primary")}>{known === "link" ? "新しいリンクを送る" : "もう一度ログイン"}</HostLoginLink>
        <a href={HOST_INTRO_PATH} className={hostButtonClass("secondary")}>体験の提供について</a>
      </div>
    </main>
  );
}
