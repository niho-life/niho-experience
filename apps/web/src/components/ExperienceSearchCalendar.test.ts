import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperienceSearchCalendar } from "./ExperienceSearchCalendar";

const render = (props: Partial<Parameters<typeof ExperienceSearchCalendar>[0]> = {}, locale: "en" | "ja" = "en") =>
  renderToStaticMarkup(createElement(ExperienceSearchCalendar, { locale, start: "2026-11-28", end: "2027-01-26", value: null, available: null, onChange: () => undefined, ...props }));

describe("ExperienceSearchCalendar（#698）", () => {
  it("開催のある日は淡い緑・太字、選んだ日は緑＋苔色の枠で黒ではなく、ほかの日は押せない（日ごとの件数は出さない）", () => {
    const html = render({ value: "2026-11-30", available: new Set(["2026-11-29", "2026-11-30"]) });
    expect(html).toContain('aria-label="Sun 29 Nov, something on"');
    expect(html).toMatch(/class="[^"]*bg-leaf-pale font-extrabold[^"]*"[^>]*aria-label="Sun 29 Nov, something on"/);
    expect(html).toMatch(/class="[^"]*bg-leaf font-extrabold text-ink ring-2 ring-inset ring-moss[^"]*"[^>]*aria-pressed="true"[^>]*aria-label="Mon 30 Nov, something on"/);
    expect(html).toMatch(/disabled=""[^>]*aria-label="Sat 28 Nov, nothing on"/);
    expect(html).not.toContain("bg-ink");
    expect(html).toContain("Something on");
    expect(html).toContain("Nothing on");
    expect(html).toContain("Any day");
  });

  it("開催日を読めていない（null）ときは、窓の中のどの日も選べて印は付かない。窓の外は選べない", () => {
    const html = render({ available: null });
    expect(html).not.toContain("something on");
    expect(html).not.toContain("Something on");
    expect(html).toContain('aria-label="Sat 28 Nov"');
    expect(html).not.toMatch(/disabled=""[^>]*aria-label="Sat 28 Nov"/);
    // Today's month shows days before the window as closed.
    expect(html).toMatch(/disabled=""[^>]*aria-label="Sun 1 Nov"/);
    expect(html).toContain('aria-label="Previous month"');
  });

  it("月は、選んだ日の月、なければ開催のある最初の日の月、なければ今日の月で開く", () => {
    expect(render({ available: new Set(["2027-01-05"]) })).toContain("January 2027");
    expect(render({ available: new Set(["2027-01-05"]), value: "2026-12-10" })).toContain("December 2026");
    expect(render({ available: null })).toContain("November 2026");
  });

  it("日本語：見出し・曜日・凡例が日本語", () => {
    const html = render({ available: new Set(["2026-11-29"]) }, "ja");
    expect(html).toContain("2026年11月");
    expect(html).toContain("開催のある日");
    expect(html).toContain("開催なし");
    expect(html).toContain("いつでも");
    expect(html).toContain("、開催あり");
    expect(html).toContain("前の月");
  });
});
