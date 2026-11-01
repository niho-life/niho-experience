import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostNotificationEmailConfirm } from "@/components/host/HostNotificationEmailConfirm";
import { config } from "@/lib/config";
import { requireHostConsole } from "@/lib/host/server";

export const metadata: Metadata = { title: "通知の宛先の確認", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * The link in 「通知の宛先の確認」 (#194, owner decision 2026-11-01): `/host/notification-email#t=<token>`. The server never
 * sees the token on the GET (it is in the fragment); the page reads it in the browser and changes the address only when the
 * button is pressed, so a link scanner that opens the page changes nothing. No session is needed: the link proves the inbox,
 * and the request was made by the signed-in host. 404 while this site sends hosts no email.
 */
export default function HostNotificationEmailPage() {
  requireHostConsole();
  if (!config.hostMailEnabled) notFound();
  return <HostNotificationEmailConfirm />;
}
