const MULTIPLE_OWNERS = "Host Account already owns multiple providers; inspect stg before proceeding";
const CHANGED_FIXTURE = "Translation fixture membership changed; refusing to create a replacement";

export function inspectTranslationFixtureMemberships(memberships, fixtureProviderPrefix) {
  const activeOwners = memberships.filter((membership) => membership.active === true && membership.role === "OWNER");
  if (activeOwners.length > 1) return { kind: "invalid", message: MULTIPLE_OWNERS };
  if (activeOwners.length === 1) return { kind: "owner", providerId: activeOwners[0].provider_id };

  const existingFixtureMembership = memberships.some((membership) =>
    typeof membership.provider_id === "string" && membership.provider_id.startsWith(fixtureProviderPrefix));
  if (existingFixtureMembership) return { kind: "invalid", message: CHANGED_FIXTURE };

  return { kind: "none" };
}
