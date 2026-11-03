import "server-only";
import { Storage } from "@google-cloud/storage";

export interface ExperiencePublicMediaStorage {
  read(objectKey: string): Promise<Buffer>;
}

class GoogleExperiencePublicMediaStorage implements ExperiencePublicMediaStorage {
  readonly #bucket;

  constructor(bucketName: string) {
    this.#bucket = new Storage().bucket(bucketName);
  }

  async read(objectKey: string): Promise<Buffer> {
    const [bytes] = await this.#bucket.file(objectKey).download();
    return bytes;
  }
}

export function experiencePublicMediaStorage(): ExperiencePublicMediaStorage | null {
  const bucketName = process.env.EXPERIENCE_PUBLIC_MEDIA_BUCKET?.trim();
  return bucketName ? new GoogleExperiencePublicMediaStorage(bucketName) : null;
}
