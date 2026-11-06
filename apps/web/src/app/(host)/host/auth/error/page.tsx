import type { Metadata } from "next";
import { HostLoginLink } from "@/components/host/HostAppWindow";
import { hostButtonClass, HOST_HEADING } from "@/components/host/host-ui";
import { HOST_INTRO_PATH, HOST_LOGIN_PATH, LOGIN_ERROR_REASONS, hostInvitationLoginPath, hostPreparationLoginPath, invitationIdOrNull, preparationCaseIdOrNull, type LoginErrorReason } from "@/lib/host/routes";
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
};

export default async function HostLoginErrorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireHostConsole();
  const { reason, preparationCaseId: rawPreparationCaseId, invitationId: rawInvitationId } = await searchParams;
  const known = LOGIN_ERROR_REASONS.find((candidate) => candidate === reason) ?? "unavailable";
  // Experience host accounts (ADR 0003): a sign-in that failed for any other reason is told as the store's outage.
  const message = config.hostAccountsEnabled && known !== "link" ? "ログインできませんでした。時間をおいてもう一度お試しください。" : MESSAGES[known];
  const preparationCaseId = preparationCaseIdOrNull(rawPreparationCaseId);
  const invitationId = invitationIdOrNull(rawInvitationId);
  return (
    <main id="main" className="mx-auto w-full max-w-xl px-4 py-16">
      <h1 className={`${HOST_HEADING} text-2xl`}>ログインできませんでした</h1>
      <p role="alert" className="mt-3 text-ink-soft">{message}</p>
      {/* Plain links: login is a route handler, and /host belongs to the traveler site's root. */}
      <div className="mt-8 flex flex-wrap gap-3">
        <HostLoginLink href={invitationId ? hostInvitationLoginPath(invitationId) : preparationCaseId ? hostPreparationLoginPath(preparationCaseId) : HOST_LOGIN_PATH} className={hostButtonClass("primary")}>{known === "link" ? "新しいリンクを送る" : "もう一度ログイン"}</HostLoginLink>
        <a href={HOST_INTRO_PATH} className={hostButtonClass("secondary")}>体験の提供について</a>
      </div>
    </main>
  );
}
