/**
 * The frame of the host's sign-in page (/host/auth/sign-in): the site's wordmark above the page, as on the traveler site, so
 * the page says whose it is and leads back to the site. It sits outside `<main>`: the entrance's one link stays the one in it.
 * The wordmark is lang="en", in the brand face (globals.css maps the faces back under [lang="en"]), like SiteChrome's.
 */
const JA_SITE_PATH = "/ja";

export function HostEntranceHeader() {
  return (
    <header className="flex h-[60px] shrink-0 items-center px-4 sm:h-[72px] sm:px-7">
      {/* A plain link (as HostNav's 体験サイトを見る): the traveler site has its own root layout. */}
      <a href={JA_SITE_PATH} lang="en" className="flex min-h-11 items-center gap-2 font-display text-xl font-semibold tracking-[-0.01em]">
        {/* eslint-disable-next-line @next/next/no-img-element -- the site's fixed mark from public/ */}
        <img src="/icon.svg" alt="" width={32} height={32} className="size-7 sm:size-8" />
        NIHO Travel
      </a>
    </header>
  );
}

/**
 * 「NIHO アカウントでログイン」: the primary pill, full width up to 360px, with NIHO's pebble mark before its text (as a
 * sign-in-with button). Mark and text are centred together, so the text stays on one line down to 320px.
 */
export const NIHO_LOGIN_BUTTON =
  "flex min-h-[54px] w-full items-center justify-center gap-2.5 rounded-full bg-leaf px-3 text-[1rem] font-bold leading-tight text-ink transition-colors hover:bg-leaf-hover";

/** NIHO's pebble mark in a white circle, before the text of NIHO_LOGIN_BUTTON. The button's text is its name. */
export function NihoMark() {
  return (
    <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-canvas">
      {/* eslint-disable-next-line @next/next/no-img-element -- a fixed mark from public/ */}
      <img src="/niho-mark.svg" alt="" width={24} height={24} className="size-6" />
    </span>
  );
}
