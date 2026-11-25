import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The return page passes Stripe's `cs` to embedReturnLink and shows only the link it gives back (#638). */
const mocks = vi.hoisted(() => ({ link: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({ config: { journeyApi: "http" } }));
vi.mock("@/lib/experience/embed-return", () => ({ embedReturnLink: mocks.link }));

import BookingReturnPage from "./page";
import JapaneseBookingReturnPage from "../../../(ja)/ja/booking/return/page";

const props = (query: Record<string, string>) => ({ searchParams: Promise.resolve(query) });

describe("booking return page", () => {
  beforeEach(() => {
    mocks.link.mockReset().mockResolvedValue({ href: "https://host.example", host: "host.example" });
  });

  it("passes cs to embedReturnLink and draws the link back to the host's site", async () => {
    const html = renderToStaticMarkup(await BookingReturnPage(props({ type: "instant", cs: "cs_test_synthetic1" })));
    expect(mocks.link).toHaveBeenCalledWith("cs_test_synthetic1");
    expect(html).toContain('<a href="https://host.example" rel="noopener noreferrer"');
    expect(html).toContain("Back to host.example");

    const ja = renderToStaticMarkup(await JapaneseBookingReturnPage(props({ type: "instant", cs: "cs_test_synthetic1" })));
    expect(mocks.link).toHaveBeenLastCalledWith("cs_test_synthetic1");
    expect(ja).toContain("host.example に戻る");
  });

  it("draws no link when there is none", async () => {
    mocks.link.mockResolvedValue(undefined);
    const html = renderToStaticMarkup(await BookingReturnPage(props({ type: "instant" })));
    expect(mocks.link).toHaveBeenCalledWith(undefined);
    expect(html).not.toContain("Back to");
    expect(html).not.toContain("host.example");
    const ja = renderToStaticMarkup(await JapaneseBookingReturnPage(props({ type: "instant", cs: "cs_test_synthetic1" })));
    expect(ja).not.toContain("に戻る");
  });
});
