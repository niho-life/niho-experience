import "server-only";
import { Storage } from "@google-cloud/storage";

export interface ExperiencePublicMediaStorage {
  write(objectKey: string, bytes: Buffer): Promise<void>;
  read(objectKey: string): Promise<Buffer>;
  remove(objectKey: string): Promise<void>;
}

class GoogleExperiencePublicMediaStorage implements ExperiencePublicMediaStorage {
  readonly #bucket;

  constructor(bucketName: string) {
    this.#bucket = new Storage().bucket(bucketName);
  }

  async write(objectKey: string, bytes: Buffer): Promise<void> {
    await this.#bucket.file(objectKey).save(bytes, {
      resumable: false,
      validation: "crc32c",
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType: "image/jpeg", cacheControl: "private, no-store" },
    });
  }

  async read(objectKey: string): Promise<Buffer> {
    const [bytes] = await this.#bucket.file(objectKey).download();
    return bytes;
  }

  async remove(objectKey: string): Promise<void> {
    await this.#bucket.file(objectKey).delete({ ignoreNotFound: true });
  }
}

export function experiencePublicMediaStorage(): ExperiencePublicMediaStorage | null {
  const bucketName = process.env.EXPERIENCE_PUBLIC_MEDIA_BUCKET?.trim();
  return bucketName ? new GoogleExperiencePublicMediaStorage(bucketName) : null;
}
