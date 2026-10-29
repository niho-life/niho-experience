import { redirect } from "next/navigation";
import { HostAppSurfaceGuard, HostLoginLink, HostResumeRefresh } from "@/components/host/HostAppWindow";
import { HostRefreshGate, HostSessionKeeper } from "@/components/host/HostSessionKeeper";
import { HostShell } from "@/components/host/HostShell";
import { hostButtonClass, HOST_HEADING, HOST_PAGE } from "@/components/host/host-ui";
import { HostPageBody } from "@/components/host/ui";
import { config } from "@/lib/config";
import { calendarConsoleChoices } from "@/lib/experience/calendar-actor";
import type { ProductOperatorAssignment } from "@niho-experience/experience-store";
import { HOST_HOME_PATH, HOST_INTRO_PATH, HOST_LAUNCH_PATH, HOST_LOGIN_PATH, HOST_LOGOUT_PATH } from "@/lib/host/routes";
import { isHostMock, loadHostProviders, readHostSession, requireHostConsole, type ProvidersLoad } from "@/lib/host/server";
import { productOperatorRepository } from "@/lib/experience/store-server";

function ProvidersProblem({ status }: { status: Exclude<ProvidersLoad["status"], "ok" | "refresh" | "signed-out"> }) {
  if (status === "rejected") {
    return (
      <div role="alert" className="space-y-4">
        <h1 className={`${HOST_HEADING} text-2xl`}>もう一度ログインしてください</h1>
        <p className="text-ink-soft">NIHO との接続が終了しています。ほかの端末でログアウトした場合などに起こります。</p>
        <div className="flex flex-wrap gap-3">
          <HostLoginLink href={HOST_LOGIN_PATH} className={hostButtonClass("primary")}>NIHO でログイン</HostLoginLink>
          <form method="post" action={HOST_LOGOUT_PATH} data-niho-navigation-form>
            <button type="submit" className={hostButtonClass("secondary")}>ログアウト</button>
          </form>
        </div>
      </div>
    );
  }
  return (
    <div role="alert" className="space-y-4">
      <h1 className={`${HOST_HEADING} text-2xl`}>提供者の情報を読み込めませんでした</h1>
      <p className="text-ink-soft">NIHO に接続できませんでした。時間をおいてもう一度お試しください。</p>
      <a href={HOST_HOME_PATH} className={hostButtonClass("secondary")}>もう一度読み込む</a>
    </div>
  );
}

/**
 * The signed-in frame: the sidebar (PC) or the header and bottom tabs (phones)
 * around every console page (HostShell, #84). Rendering never refreshes the
 * session: an expired ID token hands over to the browser (HostRefreshGate),
 * which refreshes through the cross-tab lock and reloads.
 */
export default async function HostConsoleLayout({ children }: { children: React.ReactNode }) {
  requireHostConsole();
  const session = await readHostSession();
  // With the app on, a host without a session signs in on the app's start page, inside its window (#177).
  if (!session) redirect(config.hostPwaEnabled ? HOST_LAUNCH_PATH : HOST_INTRO_PATH);
  const load = await loadHostProviders();
  // Inside the installed app, only a session signed in there is used (#177).
  const appGuard = <HostAppSurfaceGuard enabled={config.hostPwaEnabled} appSurface={session.surface === "app"} />;

  if (load.status === "refresh" || load.status === "signed-out") {
    return (
      <main id="main" className={HOST_PAGE}>
        {appGuard}
        <HostRefreshGate />
      </main>
    );
  }

  const account = { displayName: session.displayName, iconUrl: session.iconUrl };
  let assignments: readonly ProductOperatorAssignment[] = [];
  if (load.status === "ok" && !isHostMock()) {
    const repository = productOperatorRepository();
    if (repository) {
      try { assignments = await repository.listAssignments(session.nihoUserId); }
      catch { /* Current NIHO members retain their existing read access; grants fail closed. */ }
    }
  }
  const choices = calendarConsoleChoices(load.status === "ok" ? load.providers : [], assignments);
  return (
    <>
      {appGuard}
      <HostSessionKeeper idTokenExpiresAt={session.idTokenExpiresAt} />
      <HostResumeRefresh enabled={config.hostPwaEnabled} />
      {/* The sidebar and the phone menus are client components: they get the id, name and role, not NIHO's internal ids. */}
      <HostShell account={account} providers={choices} nihoAppUrl={config.nihoWebOrigin} preview={isHostMock()}>
        {load.status === "ok" ? (
          children
        ) : (
          <HostPageBody>
            <ProvidersProblem status={load.status} />
          </HostPageBody>
        )}
      </HostShell>
    </>
  );
}
