import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HostPublicationStages } from "./HostPublicationStages";
import { publicationStages, type StageInput } from "./publication-stages";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

const render = (over: Partial<StageInput> = {}, busy = false, publicHref: string | null = null) => renderToStaticMarkup(
  <HostPublicationStages
    stages={publicationStages({ status: "DRAFT", publicationBlockers: [], publicationNeedsUpdate: false, dirty: false, conflict: false, ...over })}
    busy={busy} publicHref={publicHref} onRun={() => undefined} onShowBlockers={() => undefined}
  />,
);

describe("the two buttons above the editor (#706)", () => {
  it("shows both, the first enabled, the second disabled with its reasons in words under it", () => {
    const html = render({ pageBlockers: [], bookingBlockers: ["CONNECT_NOT_READY", "SCHEDULE_REQUIRED"], publicationBlockers: ["CONNECT_NOT_READY", "SCHEDULE_REQUIRED"] });
    expect(html).toContain("下書き");
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>ページを公開する<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>予約の受付を始める<\/button>/);
    expect(html).toContain("予約の受付には、受取口座・開催枠が必要です。");
    expect(html).toContain("必要なことを見る");
  });

  it("disables the page button for its own reasons", () => {
    const html = render({ pageBlockers: ["PHOTOS_REQUIRED", "PRICE_REQUIRED"], bookingBlockers: [] });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>ページを公開する<\/button>/);
    expect(html).toContain("ページの公開には、写真（と写真の説明）・料金が必要です。");
  });

  it("while a request runs, both are off", () => {
    const html = render({ pageBlockers: [], bookingBlockers: [] }, true);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>ページを公開する<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>予約の受付を始める<\/button>/);
  });

  it("page public, bookings not open: a link to the page and the start button as the next step", () => {
    const html = render({ status: "PUBLISHED", pageBlockers: [], bookingBlockers: [], bookingOpen: false }, false, "/experiences/walk");
    expect(html).toContain("公開中・予約の受付は準備中");
    expect(html).toContain('href="/experiences/walk"');
    expect(html).not.toContain(">ページを公開する<");
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>予約の受付を始める<\/button>/);
  });

  it("selling: the stop button replaces the start button and says the page stays public", () => {
    const html = render({ status: "PUBLISHED", pageBlockers: [], bookingBlockers: [], bookingOpen: true }, false, "/experiences/walk");
    expect(html).toContain("公開中・予約受付中");
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>予約の受付を止める<\/button>/);
    expect(html).not.toContain(">予約の受付を始める<");
    expect(html).toContain("止めても、ページは公開のままです。");
  });

  it("with unsaved edits the stop button waits for a save", () => {
    const html = render({ status: "PUBLISHED", bookingOpen: true, dirty: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>予約の受付を止める<\/button>/);
    expect(html).toContain("入力を保存してから止められます。");
  });
});
