import type { Metadata } from "next";
import { HostLoginLink } from "@/components/host/HostAppWindow";
import { hostButtonClass, HOST_HEADING } from "@/components/host/host-ui";
import { HOST_INTRO_PATH, HOST_LOGIN_PATH, LOGIN_ERROR_REASONS, hostPreparationLoginPath, preparationCaseIdOrNull, type LoginErrorReason } from "@/lib/host/routes";
import { requireHostConsole } from "@/lib/host/server";

export const metadata: Metadata = { title: "ログインできませんでした" };

const MESSAGES: Record<LoginErrorReason, string> = {
  expired: "ログインの手続きが時間切れになりました（10 分）。もう一度、最初からお試しください。",
  state: "安全のため、ログインを中断しました。別のタブや古い画面から戻った場合に起こります。もう一度お試しください。",
  denied: "NIHO でログインが取り消されました。続けるには、もう一度ログインしてください。",
  rejected: "NIHO でのログインを確認できませんでした。もう一度お試しください。",
  unavailable: "NIHO に接続できませんでした。時間をおいてもう一度お試しください。",
};

export default async function HostLoginErrorPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireHostConsole();
  const { reason, preparationCaseId: rawPreparationCaseId } = await searchParams;
  const known = LOGIN_ERROR_REASONS.find((candidate) => candidate === reason) ?? "unavailable";
  const preparationCaseId = preparationCaseIdOrNull(rawPreparationCaseId);
  return (
    <main id="main" className="mx-auto w-full max-w-xl px-4 py-16">
      <h1 className={`${HOST_HEADING} text-2xl`}>ログインできませんでした</h1>
      <p role="alert" className="mt-3 text-ink-soft">{MESSAGES[known]}</p>
      {/* Plain links: login is a route handler, and /host belongs to the traveler site's root. */}
      <div className="mt-8 flex flex-wrap gap-3">
        <HostLoginLink href={preparationCaseId ? hostPreparationLoginPath(preparationCaseId) : HOST_LOGIN_PATH} className={hostButtonClass("primary")}>もう一度ログイン</HostLoginLink>
        <a href={HOST_INTRO_PATH} className={hostButtonClass("secondary")}>体験の提供について</a>
      </div>
    </main>
  );
}
