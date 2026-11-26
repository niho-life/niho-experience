import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TrackView, TrackedLink } from "@/components/Analytics";
import { buttonClass } from "@/components/ui";
import { config } from "@/lib/config";
import { safeHttpsUrl, safeNihoProviderUrl } from "@/lib/safe-url";
import { publicMetadata } from "@/lib/public-metadata";
import { nihoIdOrNull } from "@/lib/host/providers";
import { HOST_EMAIL_SIGN_IN_PATH, HOST_LOGIN_PATH, hostLandingPath } from "@/lib/host/routes";
import { isHostMock, readHostSession } from "@/lib/host/server";
import type { SiteLocale } from "@/lib/localized-content";
import { englishAlternates, japaneseStaticMetadata } from "@/lib/locale-metadata";
import { groupInquiryOpen } from "@/lib/group-inquiry-links";
import { inquiryHref } from "@/lib/group-inquiry-entry";
import { HOST_PAGE, HOST_PLANS } from "@/lib/ja-service-copy";
import { HOST_PAGE_EN, HOST_PLANS_EN } from "@/lib/host-text";
import type { HostPageContentCopy, HostPlanCopy } from "@/lib/ja-service-copy";

type SearchParams = Record<string, string | string[] | undefined>;

export async function englishHostMetadata(): Promise<Metadata> {
  return { ...publicMetadata("Host an experience with NIHO", "Share a meal, a craft or a favorite walk with travelers in Kamakura. NIHO helps you prepare, list and take bookings.", `${config.siteUrl}/host`), alternates: await englishAlternates("/host") };
}

export async function japaneseHostMetadata(): Promise<Metadata> {
  try { return await japaneseStaticMetadata("host"); }
  catch { return { title: "Japanese host page unavailable", robots: { index: false, follow: false } }; }
}

/**
 * With HOST_CONSOLE_ENABLED, signed-in hosts go straight to the console and others get a sign-in link.
 * Only a well-formed `providerId` is carried over.
 */
export async function hostConsoleEntry(query: SearchParams): Promise<{ loginHref: string } | null> {
  if (!config.hostConsoleEnabled) return null;
  const providerId = nihoIdOrNull(query.providerId);
  let signedIn = false;
  try { signedIn = (await readHostSession()) !== null; } catch { signedIn = false; }
  if (signedIn) redirect(hostLandingPath(providerId, query.connect));
  const params = new URLSearchParams();
  if (providerId) params.set("providerId", providerId);
  if (isHostMock() && query.mock === "empty") params.set("mock", "empty");
  return { loginHref: params.size ? `${HOST_LOGIN_PATH}?${params}` : config.hostNihoLoginEnabled ? HOST_EMAIL_SIGN_IN_PATH : HOST_LOGIN_PATH };
}

function HostPlans({ plans, copy }: { plans: readonly HostPlanCopy[]; copy: HostPageContentCopy }) {
  return <section aria-labelledby="host-plans-heading" className="py-6">
    <h2 id="host-plans-heading" className="text-[1.5rem]">{copy.plansTitle}</h2>
    <div className="mt-5 grid gap-4 md:grid-cols-3">
      {plans.map((plan) => <article key={plan.id} className={`flex flex-col rounded-[18px] border bg-white p-5 ${plan.highlight ? "border-moss" : "border-line"}`}>
        <h3 className="text-[1.25rem] leading-snug">{plan.name}</h3>
        <p className="mt-1"><b className="text-[1.5rem]">{plan.rate}</b> <small className="text-ink-soft">{copy.rateLabel}</small></p>
        <p className="mt-1 text-[0.9375rem] font-extrabold text-moss">{plan.seller}</p>
        <p className="mt-3 text-ink-soft">{plan.lead}</p>
        <h4 className="mt-4 text-[0.9375rem] font-extrabold">{copy.you}</h4>
        <ul className="mt-1 grid list-disc gap-1 pl-5 text-[0.9375rem] text-ink-soft">{plan.you.map((item) => <li key={item}>{item}</li>)}</ul>
        <h4 className="mt-4 text-[0.9375rem] font-extrabold">{copy.niho}</h4>
        <ul className="mt-1 grid list-disc gap-1 pl-5 text-[0.9375rem] text-ink-soft">{plan.niho.map((item) => <li key={item}>{item}</li>)}</ul>
      </article>)}
    </div>
    <p className="mt-3 text-sm text-ink-soft">{copy.switchNote}</p>
  </section>;
}

function HostStepsAndQuestions({ copy }: { copy: HostPageContentCopy }) {
  return <section className="grid gap-10 py-6 md:grid-cols-2">
    <div>
      <h2 className="text-[1.5rem]">{copy.stepsTitle}</h2>
      <ol className="mt-5 grid gap-4">
        {copy.steps.map((step, index) => <li key={step.title} className="flex gap-4">
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-leaf-pale font-extrabold text-moss">{index + 1}</span>
          <span><b className="block">{step.title}</b><span className="text-ink-soft">{step.body}</span></span>
        </li>)}
      </ol>
    </div>
    <div>
      <h2 className="text-[1.5rem]">{copy.questionsTitle}</h2>
      <div className="mt-4 border-t border-line">
        {copy.questions.map((item) => <details key={item.question} className="group border-b border-line">
          <summary className="flex min-h-11 cursor-pointer list-none items-center py-4 font-extrabold [&::-webkit-details-marker]:hidden">{item.question}</summary>
          <p className="pb-4 text-ink-soft">{item.answer}</p>
        </details>)}
      </div>
    </div>
  </section>;
}

/** One page structure for both languages; the Japanese plan and fee terms are also shown in English. */
export async function HostPageContent({ searchParams, locale }: { searchParams: Promise<SearchParams>; locale: SiteLocale }) {
  const copy = locale === "ja" ? HOST_PAGE : HOST_PAGE_EN;
  const plans = locale === "ja" ? HOST_PLANS : HOST_PLANS_EN;
  const consoleEntry = await hostConsoleEntry(await searchParams);
  const nihoProviderUrl = safeNihoProviderUrl(config.nihoHostStartUrl, config.nihoWebOrigin);
  const managementUrl = consoleEntry ? null : nihoProviderUrl;
  const startUrl = config.hostSignupMode === "open" ? managementUrl : null;
  const contactUrl = safeHttpsUrl(config.hostPilotContactUrl);
  const talkHref = locale === "ja" && groupInquiryOpen() ? inquiryHref("ja", { type: "LISTING", from: "LISTING" }) : contactUrl;
  const loginHref = consoleEntry?.loginHref ?? managementUrl;
  const loginTitle = locale === "ja" ? "登録済みのホストの方" : "Already registered as a host?";
  const loginBody = locale === "ja" ? "ログインして体験、予約、売上を確認できます。" : "Sign in to see your experiences, bookings and sales.";
  const loginLabel = consoleEntry ? copy.loginLabel : locale === "ja" ? "NIHOで体験を管理" : "Manage your experiences on NIHO";
  return <>
    {locale === "en" ? <TrackView event="host_view" props={{ signup_mode: config.hostSignupMode === "open" ? "open" : "pilot" }} /> : null}
    <div className="mx-auto w-full max-w-[64rem] px-4 pb-16">
      <header className={`grid items-center gap-6 py-10 sm:py-14 ${loginHref ? "md:grid-cols-[minmax(0,1fr)_minmax(15rem,19rem)] md:gap-10" : ""}`}>
        <div>
          <p className="hand text-[1.25rem] text-moss">{copy.eyebrow}</p>
          <h1 className="mt-1 max-w-[24ch] text-[2rem] leading-tight sm:text-[2.75rem]">{copy.title}</h1>
          <p className="mt-4 max-w-[40rem] text-[1.0625rem] text-ink-soft">{copy.lead}</p>
          {startUrl ? <TrackedLink href={startUrl} event="host_start" props={{ signup_mode: "open" }} className={buttonClass("primary", "mt-6 max-sm:w-full")}>{locale === "ja" ? "NIHOアカウントで始める" : "Start with your NIHO account"}</TrackedLink>
            : talkHref ? <TrackedLink href={talkHref} event="host_start" props={{ signup_mode: locale === "ja" ? "ja" : "pilot" }} className={buttonClass("primary", "mt-6 max-sm:w-full")}>{copy.talk}</TrackedLink> : null}
        </div>
        {loginHref ? <section aria-labelledby="registered-host-title" className="rounded-[18px] border border-line bg-sand p-5">
          <h2 id="registered-host-title" className="font-sans text-lg font-bold">{loginTitle}</h2>
          <p className="mt-2 text-sm text-ink-soft">{loginBody}</p>
          <a href={loginHref} className={buttonClass("secondary", "mt-4 w-full text-sm")}>{loginLabel}</a>
        </section> : null}
      </header>

      <p className="mb-10 rounded-[16px] bg-leaf-pale px-5 py-4"><b className="block">{copy.note.title}</b><span className="text-ink-soft">{copy.note.body}</span></p>
      <HostPlans plans={plans} copy={copy} />
      <HostStepsAndQuestions copy={copy} />
      {talkHref ? <section className="mt-6 rounded-[22px] bg-leaf-pale px-6 py-8 sm:px-10">
        <h2 className="text-[1.5rem]">{copy.closing.title}</h2>
        <p className="mt-2 text-ink-soft">{copy.closing.body}</p>
        <TrackedLink href={talkHref} event="host_start" props={{ signup_mode: locale === "ja" ? "ja" : "pilot" }} className={buttonClass("primary", "mt-5 max-sm:w-full")}>{copy.talk}</TrackedLink>
      </section> : null}
    </div>
  </>;
}
