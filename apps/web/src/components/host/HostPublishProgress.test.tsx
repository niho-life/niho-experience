import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HostPublishProgress, progressProductsFrom } from "./HostPublishProgress";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

describe("HostPublishProgress (#706)", () => {
  it("draws the two stages with their rows, the next step as the primary button, and each row linking to its screen", () => {
    const html = renderToStaticMarkup(<HostPublishProgress hostName="合成ホスト" linkProviderId={null} initialProducts={[{ id: "p1", title: "Walk", status: "DRAFT", publicationBlockers: ["CONNECT_NOT_READY"], pageBlockers: [], bookingBlockers: ["CONNECT_NOT_READY"], bookingOpen: false }]} />);
    expect(html).toContain("公開までの道のり");
    expect(html).toContain("体験のページを公開する");
    expect(html).toContain("予約の受付を始める");
    for (const title of ["ホストの情報", "体験のページを作る", "ページを公開する", "売上の受け取り方", "受取口座", "販売者情報", "開催枠"]) expect(html).toContain(title);
    expect(html).not.toContain("連絡用メール");
    expect(html).toContain('href="/host/experiences/p1"');
    expect(html).toContain("残り：受取口座");
  });

  it("is empty when every experience takes bookings, and nothing is drawn before the list is read", () => {
    expect(renderToStaticMarkup(<HostPublishProgress hostName="x" linkProviderId={null} initialProducts={[{ id: "p1", title: "Walk", status: "PUBLISHED", publicationBlockers: [], bookingOpen: true }]} />)).toBe("");
    expect(renderToStaticMarkup(<HostPublishProgress hostName="x" linkProviderId={null} />)).toBe("");
  });

  it("reads the list API's products and leaves out one that does not look right", () => {
    const products = progressProductsFrom({ products: [
      { id: "a", status: "DRAFT", publicationBlockers: ["PRICE_REQUIRED"], pageBlockers: ["PRICE_REQUIRED"], bookingBlockers: [], bookingOpen: false, draft: { publicTitle: "A" } },
      { id: "b", status: "NOPE", publicationBlockers: [] },
      { id: "c", status: "PUBLISHED", publicationBlockers: "x" },
    ] });
    expect(products).toEqual([{ id: "a", title: "A", status: "DRAFT", publicationBlockers: ["PRICE_REQUIRED"], pageBlockers: ["PRICE_REQUIRED"], bookingBlockers: [], bookingOpen: false }]);
    expect(progressProductsFrom(null)).toEqual([]);
  });
});
