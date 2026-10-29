import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EN_STATIC_COPY_V1, HostViewV1 } from "@niho/experience-presentation/v1";
import { TrackView, TrackedLink } from "@/components/Analytics";
import { HandIcon } from "@/components/HandIcon";
import { buttonClass } from "@/components/ui";
import { PRESENTATION_PRIMITIVES_V1 } from "@/components/PresentationV1";
import { config } from "@/lib/config";
import { safeHttpsUrl, safeNihoProviderUrl } from "@/lib/safe-url";
import { HOST_BAND_VIDEO } from "@/lib/site-media";
import { publicMetadata } from "@/lib/public-metadata";
import { nihoIdOrNull } from "@/lib/host/providers";
import { HOST_LOGIN_PATH, hostLandingPath } from "@/lib/host/routes";
import { isHostMock, readHostSession } from "@/lib/host/server";
import { getJapaneseCopy, type SiteLocale } from "@/lib/localized-content";
import { JapaneseUnavailable } from "@/components/JapaneseUnavailable";
import { englishAlternates } from "@/lib/locale-metadata";
import { japaneseStaticMetadata } from "@/lib/locale-metadata";

export async function englishHostMetadata(): Promise<Metadata> {
  return { ...publicMetadata("Host an experience with NIHO", "Share a meal, a craft or a favorite walk with travelers in Kamakura. NIHO helps you prepare, list and take bookings.", `${config.siteUrl}/host`), alternates: await englishAlternates("/host") };
}
export async function japaneseHostMetadata(): Promise<Metadata> {
  try { return await japaneseStaticMetadata("host"); }
  catch { return { title: "Japanese host page unavailable", robots: { index: false, follow: false } }; }
}

const PILOT_STEPS = [
  { title: "Tell us your idea", body: "A short chat about what you'd like to share, how often, and for how many guests." },
  { title: "Prepare it together", body: "NIHO helps write the English page, plan photos, set a price and agree the cancellation terms with you." },
  { title: "Set up with your NIHO account", body: "Sign in to NIHO, choose or connect the account you'll be paid to, and add your dates." },
  { title: "Welcome your guests", body: "Bookings and guest details arrive in NIHO. You host; we help with questions along the way." },
];
const OPEN_STEPS = [
  { title: "Set up your host profile", body: "Use your NIHO account to register yourself or your small business and start an experience draft." },
  { title: "Prepare your listing", body: "Add the details and photos with NIHO's editing support. NIHO reviews the listing before it goes live." },
  { title: "Set up payments and dates", body: "Choose an account you're authorized to use or connect Stripe. Stripe may ask you to verify your identity." },
  { title: "Welcome your guests", body: "Once your listing and payout account are ready, bookings and guest details arrive in NIHO." },
];
const YOU = ["Host the experience and look after your guests", "Keep your dates and capacity up to date", "Check facts in your listing, like what's included and where to meet", "Complete identity and payout checks with Stripe if your account needs them"];
const NIHO = ["Help write and edit your page in English", "Advise on photos, pricing and terms", "Show your experience to travelers and take bookings and payments", "Answer guest questions before the day"];

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * With HOST_CONSOLE_ENABLED, signed-in hosts go straight to the console (設定, when Stripe
 * sends them back here with `?connect=`) and others get "NIHO でログイン". Only a well-formed
 * `providerId` is carried over.
 */
async function hostConsoleEntry(query: SearchParams): Promise<{ loginHref: string } | null> {
  if (!config.hostConsoleEnabled) return null;
  const providerId = nihoIdOrNull(query.providerId);
  if (await readHostSession()) redirect(hostLandingPath(providerId, query.connect));
  const params = new URLSearchParams();
  if (providerId) params.set("providerId", providerId);
  // Preview only: `?mock=empty` signs in as a synthetic host with no providers.
  if (isHostMock() && query.mock === "empty") params.set("mock", "empty");
  return { loginHref: params.size ? `${HOST_LOGIN_PATH}?${params}` : HOST_LOGIN_PATH };
}

export async function HostPageContent({ searchParams, locale }: { searchParams: Promise<SearchParams>; locale: SiteLocale }) {
  const consoleEntry = await hostConsoleEntry(await searchParams);
  let copy = EN_STATIC_COPY_V1;
  const hostVideo = HOST_BAND_VIDEO;
  if (locale === "ja") {
    try {
      copy = (await getJapaneseCopy()).copy;
    } catch { return <JapaneseUnavailable />; }
  }
  const nihoProviderUrl = safeNihoProviderUrl(config.nihoHostStartUrl, config.nihoWebOrigin);
  // The console login replaces the links to NIHO's provider screen.
  const managementUrl = consoleEntry ? null : nihoProviderUrl;
  const startUrl = config.hostSignupMode === "open" ? managementUrl : null;
  const openSignup = config.hostSignupMode === "open" && Boolean(consoleEntry || nihoProviderUrl);
  const contactUrl = safeHttpsUrl(config.hostPilotContactUrl);
  const signup = (
    // Full width under the hero on desktop. Phone-only values are max-lg: so package-scoped base classes cannot override the lg: ones.
    <section className="max-lg:mt-7 max-lg:max-w-2xl lg:mt-10" aria-label={copy.text("host.start")}>
      {consoleEntry && openSignup ? null : startUrl ? (
        <div className="space-y-3">
          <TrackedLink href={startUrl} event="host_start" props={{ signup_mode: "open" }} className={buttonClass("primary", "text-lg")}>
            {locale === "ja" ? "NIHOアカウントで始める" : "Start with your NIHO account"}
          </TrackedLink>
          <p className="text-sm text-muted">
            {copy.text("host.feesBody")}
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-3.5 rounded-[22px] bg-leaf-pale max-lg:p-5 lg:px-7 lg:py-6">
          <HandIcon name="house" className="size-10 text-moss [stroke-width:1.5]" />
          <div>
            <p className="text-[1.0625rem] font-extrabold">{copy.text("host.peopleTitle")}</p>
            <p className="mt-1 text-[0.9375rem] text-ink-soft">{copy.text("host.peopleBody")}</p>
            {contactUrl ? <p className="mt-3"><TrackedLink href={contactUrl} event="host_start" props={{ signup_mode: "pilot" }} className="font-bold text-moss underline">
              {copy.text("host.start")}
            </TrackedLink></p> : null}
          </div>
        </div>
      )}
      {!startUrl && managementUrl ? <p className="mt-4">
        <a href={managementUrl} className="link-leaf">{locale === "ja" ? "NIHOで体験を管理" : "Manage your experiences on NIHO"}</a>
      </p> : null}
      {consoleEntry ? (
        <div className={openSignup ? "space-y-3" : "mt-5 space-y-3"}>
          {/* A plain link: the console has its own root layout and login is a route handler. */}
          <a href={consoleEntry.loginHref} lang="ja" className={buttonClass("primary", "text-lg")}>NIHO でログイン</a>
          <p className="text-sm text-muted">
            {locale === "ja" ? (openSignup ? "NIHOアカウントでログインして、ホスト登録、体験の編集、予約・売上の確認ができます。" : "NIHOでホストをしている方は、ログインして体験、予約、売上を確認できます。") : openSignup
              ? "Sign in with your NIHO account to register as a host, edit your experiences and see bookings and sales. Stripe may request identity checks."
              : "Already hosting with NIHO? Sign in to edit your experiences and see bookings and sales."}
          </p>
        </div>
      ) : null}
    </section>
  );
  const steps = locale === "ja" ? [
    { title: copy.text("host.ideaTitle"), body: copy.text("host.ideaBody") },
    { title: copy.text("host.prepareTitle"), body: copy.text("host.prepareBody") },
    { title: copy.text("host.accountTitle"), body: copy.text("host.accountBody") },
    { title: copy.text("host.welcomeTitle"), body: copy.text("host.welcomeBody") },
  ] : openSignup ? OPEN_STEPS : PILOT_STEPS;
  const roles = locale === "ja" ? {
    you: ["体験を実施し、ゲストを迎える", "日程と定員を最新に保つ", "掲載内容と集合案内を確認する", "必要な本人確認と受取口座の手続きを行う"],
    niho: ["英語の掲載原稿づくりを支援する", "写真・価格・条件を一緒に整える", "旅行者への掲載と予約・決済を扱う", "開催前のゲストの質問を支援する"],
  } : { you: YOU, niho: NIHO };
  return <>{locale === "en" ? <TrackView event="host_view" props={{ signup_mode: openSignup ? "open" : "pilot" }} /> : null}<HostViewV1 primitives={PRESENTATION_PRIMITIVES_V1} copy={copy} model={{ video: hostVideo, steps, you: roles.you, niho: roles.niho, signup, signupOpen: Boolean(startUrl || consoleEntry) }} /></>;
}
