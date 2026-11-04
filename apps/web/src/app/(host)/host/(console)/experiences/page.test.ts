import { createElement, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/components/host/HostPublicationWorkspace", () => ({ HostPublicationWorkspace: (props: Record<string, unknown>) => createElement("div", props) }));

import HostExperiencesPage from "./page";
import NewHostExperiencePage from "./new/page";
import HostExperiencePage from "./[id]/page";

describe("Experience owner-product routes", () => {
  it("uses the new Experience product workspace for list, create and edit", async () => {
    const list = HostExperiencesPage();
    const create = NewHostExperiencePage();
    const edit = await HostExperiencePage({ params: Promise.resolve({ id: "product-123" }) });
    expect(isValidElement(list) && list.props).toEqual({});
    expect(isValidElement(create) && create.props).toEqual({ create: true });
    expect(isValidElement(edit) && edit.props).toEqual({ productId: "product-123" });
  });
});
