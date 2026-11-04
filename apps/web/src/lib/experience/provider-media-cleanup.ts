import "server-only";
import type { ClaimedProviderMediaCleanup, ProviderMediaCleanupRepository } from "@niho-experience/experience-store";
import type { ExperiencePublicMediaStorage } from "./public-media-storage";

export interface ProviderMediaCleanupCounts {
  readonly claimed: number;
  readonly deleted: number;
  /** The claim stopped being eligible before completion. */
  readonly stale: number;
  /** Unsafe keys, storage failures, or completion failures. */
  readonly failed: number;
}

export interface ProviderMediaCleanupDeps {
  readonly repository: Pick<ProviderMediaCleanupRepository, "claim" | "complete">;
  readonly storage: Pick<ExperiencePublicMediaStorage, "remove">;
}

function expectedObjectKey(claim: ClaimedProviderMediaCleanup): string {
  return `experience-provider-media/${claim.assetId}.jpg`;
}

/** Bounded, counts-only cleanup. A failed object never prevents later claims in the same batch from being tried. */
export async function cleanupProviderMedia(
  deps: ProviderMediaCleanupDeps,
  limit = 20,
): Promise<ProviderMediaCleanupCounts> {
  const claims = await deps.repository.claim(limit);
  const counts = { claimed: claims.length, deleted: 0, stale: 0, failed: 0 };
  for (const claim of claims) {
    if (claim.objectKey !== expectedObjectKey(claim)) {
      counts.failed += 1;
      continue;
    }
    try {
      await deps.storage.remove(claim.objectKey);
      if (await deps.repository.complete(claim)) counts.deleted += 1;
      else counts.stale += 1;
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}
