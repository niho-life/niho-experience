import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { HostEntranceHeader } from "@/components/host/HostEntrance";
import { HostSelfRegistrationForm } from "@/components/host/HostSelfRegistrationForm";
import { HOST_HEADING } from "@/components/host/host-ui";
import { config } from "@/lib/config";
import { HOST_TERMS_VERSION } from "@/lib/host/host-terms";
import { HOST_REGISTER_LOGIN_PATH } from "@/lib/host/routes";
import { readRegistrationSource } from "@/lib/host/self-registration-server";
import { requireHostConsole } from "@/lib/host/server";
import { ACCOUNT_SESSION_COOKIE, REGISTRATION_COOKIE } from "@/lib/host/session";

export const metadata: Metadata = { title: "ホストとして登録", robots: { index: false, follow: false } };

function Step({ state, number, children }: { state: "done" | "now" | "next"; number: number; children: string }) {
  const mark = state === "done" ? "bg-moss text-white" : state === "now" ? "bg-leaf text-ink" : "bg-sand text-muted";
  return (
    <span aria-current={state === "now" ? "step" : undefined} className={`inline-flex items-center gap-1.5 ${state === "now" ? "text-ink" : ""}`}>
      <i aria-hidden="true" className={`grid size-5 place-items-center rounded-full text-[0.6875rem] not-italic ${mark}`}>{state === "done" ? "✓" : number}</i>
      {children}
    </span>
  );
}

/**
 * ホストとして登録 (Epic #700, #708, EXPERIENCE_HOST_SELF_REGISTRATION_ENABLED; mock idea/mock/host-self-registration-v2): the
 * continuation of the NIHO login for an account no host account is bound to. Laid out as NIHO's own login and connection
 * screens are: one centred column, the app's tile, a heading, the steps, one rounded card. A 404 without the flag.
 *
 * Who is registering is decided on the server (self-registration-server.ts): the sealed 30-minute cookie NIHO's return left (the
 * form starts from NIHO's name), or the signed-in account (a host is added to it, up to the store's limit of owned hosts); anyone else signs
 * in first. Nothing is created until the form is sent.
 */
export default async function HostStartPage() {
  requireHostConsole();
  if (!config.hostSelfRegistrationEnabled) notFound();
  const jar = await cookies();
  const source = await readRegistrationSource({ registration: jar.get(REGISTRATION_COOKIE)?.value, session: jar.get(ACCOUNT_SESSION_COOKIE)?.value });
  if (!source) redirect(HOST_REGISTER_LOGIN_PATH);
  return (
    <div className="flex min-h-dvh flex-col bg-sand">
      <HostEntranceHeader />
      <main id="main" className="flex flex-1 justify-center px-4 pt-4 pb-12">
        <div className="w-full max-w-[448px]">
          {/* eslint-disable-next-line @next/next/no-img-element -- the host app's fixed 192px icon from public/ */}
          <img src="/host-app/icon-192.png" alt="" width={72} height={72} className="mx-auto size-[72px] rounded-2xl bg-canvas shadow-[0_4px_16px_rgba(60,70,40,0.14)]" />
          <h1 className={`${HOST_HEADING} mt-3.5 text-center text-[1.4375rem] leading-snug`}>ホストとして登録</h1>
          <p aria-label="進み具合" className="mt-3 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-[0.78125rem] font-extrabold text-muted">
            <Step state="done" number={1}>ログイン</Step>
            <span aria-hidden="true" className="text-line-strong">―</span>
            <Step state="now" number={2}>ホストの登録</Step>
            <span aria-hidden="true" className="text-line-strong">―</span>
            <Step state="next" number={3}>体験のページ</Step>
          </p>
          <p className="mt-2.5 text-center text-[0.8125rem] text-ink-soft">登録も、体験のページの公開も無料です。受取口座は、予約の受付を始めるときにつなぎます。</p>
          <div className="mt-5 rounded-[26px] border border-line bg-canvas p-5 shadow-[0_14px_34px_rgba(60,70,40,0.12)]">
            <HostSelfRegistrationForm
              mode={source.kind === "niho" ? "niho" : "account"}
              nihoDisplayName={source.kind === "niho" ? source.registration.displayName : null}
              termsVersion={HOST_TERMS_VERSION}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
