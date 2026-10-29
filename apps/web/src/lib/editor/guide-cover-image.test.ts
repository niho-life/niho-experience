import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { processGuideCoverImage } from "./guide-cover-image";

vi.mock("server-only", () => ({}));

describe("guide cover image processing", () => {
  it("applies orientation, emits sRGB JPEG, and strips source metadata", async () => {
    const synthetic = await sharp({
      create: { width: 120, height: 80, channels: 3, background: { r: 40, g: 120, b: 180 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Artist: "Synthetic test author" } } })
      .toBuffer();

    const output = await processGuideCoverImage(synthetic);
    const metadata = await sharp(output.bytes).metadata();
    expect(output).toMatchObject({ width: 80, height: 120 });
    expect(metadata.format).toBe("jpeg");
    expect(metadata.space).toBe("srgb");
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it("rejects invalid bytes and formats outside JPEG/PNG", async () => {
    await expect(processGuideCoverImage(Buffer.from("not an image"))).rejects.toMatchObject({
      code: "unsupported_format",
    });
  });
});
