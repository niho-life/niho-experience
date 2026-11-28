import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { HostEntranceHeader } from "@/components/host/HostEntrance";
import { HOST_HEADING } from "@/components/host/host-ui";
import { config } from "@/lib/config";
import { HOST_TERMS_DRAFT_NOTICE, HOST_TERMS_SECTIONS, HOST_TERMS_VERSION } from "@/lib/host/host-terms";
import { requireHostConsole } from "@/lib/host/server";

export const metadata: Metadata = { title: "ホスト規約", robots: { index: false, follow: false } };

/**
 * ホスト規約 (Epic #700, #708): what a person agrees to when they register as a host by themselves. A 404 without
 * EXPERIENCE_HOST_SELF_REGISTRATION_ENABLED. The wording is a draft waiting for legal review (host-terms.ts), and says so here.
 */
export default function HostTermsPage() {
  requireHostConsole();
  if (!config.hostSelfRegistrationEnabled) notFound();
  return (
    <>
      <HostEntranceHeader />
      <main id="main" className="mx-auto w-full max-w-xl px-4 py-10 sm:py-14">
        <h1 className={`${HOST_HEADING} text-2xl`}>ホスト規約</h1>
        <p className="mt-2 text-[0.8125rem] text-muted">版：{HOST_TERMS_VERSION}</p>
        <p role="note" className="mt-4 rounded-xl bg-warn-pale p-3 text-[0.875rem] text-ink">{HOST_TERMS_DRAFT_NOTICE}</p>
        <div className="mt-8 grid gap-8">
          {HOST_TERMS_SECTIONS.map((section, index) => (
            <section key={section.id} aria-labelledby={`terms-${section.id}`}>
              <h2 id={`terms-${section.id}`} className={`${HOST_HEADING} text-[1.0625rem]`}>{index + 1}. {section.title}</h2>
              <ul className="mt-2 grid list-disc gap-2 pl-5 text-ink-soft">
                {section.points.map((point) => <li key={point}>{point}</li>)}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-10 text-sm text-muted">
          {/* A plain link: the traveler site has its own root layout. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/privacy" className="font-bold underline underline-offset-4">プライバシーポリシー</a>
        </p>
      </main>
    </>
  );
}
