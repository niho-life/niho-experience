import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HostLaunchScreen } from "@/components/host/HostLaunchScreen";
import { HOST_HOME_PATH } from "@/lib/host/routes";
import { readHostSession, requireHostConsole } from "@/lib/host/server";

export const metadata: Metadata = { title: { absolute: "NIHO 体験ホスト" } };

/**
 * The installed app's start page (#177; the manifest's start_url). Outside the console frame,
 * and it never refreshes the session: a session signed in inside the app opens ホーム, and any
 * other one is left for the browser it came from while the app signs in on its own.
 */
export default async function HostLaunchPage() {
  requireHostConsole();
  const session = await readHostSession();
  if (session?.surface === "app") redirect(HOST_HOME_PATH);
  return <HostLaunchScreen hasSession={session !== null} />;
}
