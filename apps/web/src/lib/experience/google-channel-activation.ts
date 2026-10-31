import "server-only";
import type { Pool } from "pg";
import {
  GoogleChannelActivationRepository,
  type GoogleChannelActivationApplied,
  type GoogleChannelActivationInput,
  type GoogleChannelActivationStatus,
  type HostActor,
} from "@niho-experience/experience-store";
import { googleChannelSetupEnabled } from "./google-channel-setup";

export const googleChannelActivationEnabled = () => googleChannelSetupEnabled()
  && process.env.EXPERIENCE_AIRBNB_GOOGLE_ACTIVATION_ENABLED === "true";

export function googleChannelActivationStatusDto(value: GoogleChannelActivationStatus) {
  return {
    listingId: value.listingId,
    occurrenceId: value.occurrenceId,
    state: value.state,
    expectedMappingVersion: value.expectedMappingVersion,
    expectedBindingVersion: value.expectedBindingVersion,
    expectedDesiredVersion: value.expectedDesiredVersion,
  };
}

export function googleChannelActivationAppliedDto(value: GoogleChannelActivationApplied) {
  return { commandId: value.commandId, listingId: value.listingId, occurrenceId: value.occurrenceId, state: value.state };
}

export async function executeGoogleChannelActivation(
  pool: Pool,
  actor: HostActor,
  input: GoogleChannelActivationInput,
): Promise<GoogleChannelActivationApplied> {
  return new GoogleChannelActivationRepository(pool).activate(actor, input);
}
