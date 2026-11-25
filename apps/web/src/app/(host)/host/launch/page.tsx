import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HostLaunchScreen } from "@/components/host/HostLaunchScreen";
import { HOST_HOME_PATH } from "@/lib/host/routes";
import { config } from "@/lib/config";
import { returningHostLoginPath } from "@/lib/host/returning-host";
import { readHostSession, requireHostConsole } from "@/lib/host/server";
import { sessionUsableInApp } from "@/lib/host/session";

export const metadata: Metadata = { title: { absolute: "NIHO Travel ホスト" } };

/**
 * The installed app's start page (#177; the manifest's start_url). Outside the console frame,
 * and it never refreshes the session: a session signed in inside the app opens ホーム, and any
 * other one is left for the browser it came from while the app signs in on its own. An Experience host account's
 * session (ADR 0003) is usable in the app wherever it was signed in.
 */
export default async function HostLaunchPage() {
  requireHostConsole();
  const session = await readHostSession();
  if (session && sessionUsableInApp(session)) redirect(HOST_HOME_PATH);
  // A returning host whose session ran out signs in by itself (#632); after a logout this screen waits for the button.
  if (!session) {
    const autoLogin = await returningHostLoginPath();
    if (autoLogin) redirect(autoLogin);
  }
  return <HostLaunchScreen hasSession={session !== null} emailLogin={config.hostAccountsEnabled} nihoLogin={config.hostNihoLoginEnabled} />;
}
