import type { Page } from "@playwright/test";

/**
 * Japanese text on a Japanese screen (<html lang="ja">) that is not set in NIHO Sans (#670): one line per element,
 * "tag 「text」 font-family". Hand-written accents (Caveat) pass when their Japanese falls to "NIHO Hand JA". Parts that
 * show the English site (lang="en": the host's preview, an English article being written), the stamp's SVG and form
 * fields are left out. The category is based on computed font-family and font-weight on every runner.
 */
export async function japaneseTextOutsideNihoSans(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const japanese = /[぀-ヿ㐀-鿿]/;
    const found = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      const element = node.parentElement;
      if (!element || !japanese.test(text)) continue;
      if (element.closest("script, style, noscript, svg, textarea, [lang='en']")) continue;
      const family = getComputedStyle(element).fontFamily;
      if (/"NIHO Sans"/.test(family) || /^"Caveat Variable", "NIHO Hand JA"/.test(family)) continue;
      found.add(`${element.tagName.toLowerCase()} 「${text.slice(0, 16)}」 ${family}`);
    }
    return [...found];
  });
}

/** Heading weights that do not resolve to Hiragino Kaku Gothic W6. */
export async function japaneseHeadingsOutsideW6(page: Page): Promise<string[]> {
  return page.locator('html[lang="ja"] :is(h1, h2, h3):not(:lang(en))').evaluateAll((headings) =>
    headings.flatMap((heading) => {
      const weight = getComputedStyle(heading).fontWeight;
      return weight === "600" || weight === "700" ? [] : [`${heading.textContent?.trim()}: ${weight}`];
    }),
  );
}
