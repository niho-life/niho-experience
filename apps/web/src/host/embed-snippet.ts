import { providerBookingLink } from "@/lib/provider-booking-link";

/*
 * 自分のサイトに貼る (#638, docs/embed.md「ホストが貼るもの」): what the host copies. Built from the public site's origin and the
 * published slug only; nothing is issued or stored, and none of it is secret (it is the public page's address).
 */

/** Escapes a value for an HTML attribute in double quotes (and for text). */
function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The site's origin when it is one we would hand out: https, or http on localhost while developing. */
function siteOriginOf(siteOrigin: string): string | null {
  let base: URL;
  try { base = new URL(siteOrigin); } catch { return null; }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && (base.hostname === "localhost" || base.hostname === "127.0.0.1"))) return null;
  return base.origin;
}

/** `{origin}/embed/experiences/{slug}/book`, or null for an origin or slug we would not hand out (as providerBookingLink). */
export function embedBookUrl(siteOrigin: string, slug: string): string | null {
  const origin = siteOriginOf(siteOrigin);
  if (!origin || typeof slug !== "string" || slug === "" || slug.length > 160) return null;
  return `${origin}/embed/experiences/${encodeURIComponent(slug)}/book`;
}

/** The iframe and the short script that keeps its height to the widget's (docs/embed.md「コード」). */
export function embedBookSnippet(input: { readonly siteOrigin: string; readonly slug: string; readonly title: string }): string | null {
  const url = embedBookUrl(input.siteOrigin, input.slug);
  const origin = siteOriginOf(input.siteOrigin);
  if (!url || !origin) return null;
  return [
    `<iframe src="${attribute(url)}"`,
    `  title="${attribute(`Book ${input.title}`)}" loading="lazy" style="width:100%;max-width:520px;height:760px;border:0"></iframe>`,
    `<script>(function(){var f=document.currentScript.previousElementSibling;`,
    `if(!f||f.tagName!=="IFRAME")return;`,
    `window.addEventListener("message",function(e){`,
    `  if(e.origin!==${JSON.stringify(origin)}||e.source!==f.contentWindow)return;`,
    `  var d=e.data||{};`,
    `  if(d.type==="niho-experience-embed-resize")f.style.height=Math.max(240,Math.ceil(d.height))+"px";`,
    `  if(d.type==="niho-experience-embed-top")f.scrollIntoView({block:"start"});`,
    `});})();</script>`,
  ].join("\n");
}

/** A link styled as a button to the public page with the provider's mark (予約リンク, #531), opening in a new tab. */
export function bookButtonSnippet(input: { readonly siteOrigin: string; readonly slug: string }): string | null {
  const href = providerBookingLink({ origin: input.siteOrigin, slug: input.slug, placement: "referral" });
  if (!href) return null;
  return [
    `<a href="${attribute(href)}" target="_blank" rel="noopener"`,
    `  style="display:inline-block;padding:14px 28px;border-radius:999px;background:#1c1c1a;color:#fff;font-weight:800;text-decoration:none">Book now</a>`,
  ].join("\n");
}
