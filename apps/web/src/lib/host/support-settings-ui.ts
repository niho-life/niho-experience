import {
  isExperienceHostSupportSettingsHostKind,
  isExperienceHostSupportSettingsPathId,
  type ExperienceHostSupportSettingsHost,
  type ExperienceHostSupportSettingsPutRequest,
  type ExperienceHostSupportSettingsStateResponse,
} from "@niho-experience/api-client/host-support-settings-schema";

export type HostSupportTarget = Pick<ExperienceHostSupportSettingsHost, "kind" | "id">;
export type HostSupportRequestedTarget =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; target: HostSupportTarget };

export function resolveHostSupportRequestedTarget(kind: unknown, id: unknown, malformedQuery = false): HostSupportRequestedTarget {
  if (malformedQuery) return { kind: "invalid" };
  if (kind === undefined && id === undefined) return { kind: "absent" };
  return isExperienceHostSupportSettingsHostKind(kind) && isExperienceHostSupportSettingsPathId(id)
    ? { kind: "valid", target: { kind, id } }
    : { kind: "invalid" };
}

export function isSuccessfulHostSupportSave(
  value: ExperienceHostSupportSettingsStateResponse | null,
  target: HostSupportTarget,
  command: Readonly<ExperienceHostSupportSettingsPutRequest>,
): value is ExperienceHostSupportSettingsStateResponse & { settingState: "CURRENT"; setting: NonNullable<ExperienceHostSupportSettingsStateResponse["setting"]> } {
  return Boolean(
    value
      && value.host.kind === target.kind
      && value.host.id === target.id
      && value.settingState === "CURRENT"
      && value.setting?.enabled === command.enabled
      && value.setting.consentVersion === command.consentVersion
      && value.setting.revision === command.expectedRevision + 1,
  );
}
