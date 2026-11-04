import { describe, expect, it } from "vitest";
import { photoRightsConfirmed } from "./photo-rights";

describe("photo publication permission", () => {
  const file = { name: "synthetic.jpg", size: 100 };
  const confirmation = { file, productId: "synthetic-product", placement: "PROVIDER_PHOTO" as const };

  it("requires explicit permission for the selected file and use", () => {
    expect(photoRightsConfirmed(null, file, "synthetic-product", "PROVIDER_PHOTO")).toBe(false);
    expect(photoRightsConfirmed(confirmation, file, "synthetic-product", "PROVIDER_PHOTO")).toBe(true);
  });

  it("does not carry permission to another file with the same name and size", () => {
    expect(photoRightsConfirmed(confirmation, { ...file }, "synthetic-product", "PROVIDER_PHOTO")).toBe(false);
    expect(photoRightsConfirmed(confirmation, null, "synthetic-product", "PROVIDER_PHOTO")).toBe(false);
  });

  it("does not turn permission for a provider photo into permission for a logo or product gallery", () => {
    expect(photoRightsConfirmed(confirmation, file, "synthetic-product", "BUSINESS_LOGO")).toBe(false);
    expect(photoRightsConfirmed(confirmation, file, "synthetic-product", "GALLERY")).toBe(false);
  });

  it("does not reuse permission after changing the edited product", () => {
    expect(photoRightsConfirmed(confirmation, file, "another-product", "PROVIDER_PHOTO")).toBe(false);
    expect(photoRightsConfirmed(confirmation, file, null, "PROVIDER_PHOTO")).toBe(false);
  });
});
