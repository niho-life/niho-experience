export const EXPERIENCE_PRESENTATION_IDENTITY = Object.freeze({
  schemaVersion: 2,
  renderer: "niho-experience-presentation/v1",
  sourceCommit: "0b6f1d77c1496282eae8cab1eabf516f5b8a0da7",
  tgzSha256: "c4d4d066f767c525d2d1b8455f8b9b9793d1ce6610997f9c41a7a01fc3c65bd6",
  copy: { schemaVersion: 2, keyCount: 342, sha256: "242e2111e705a14755d10f13d8d16820792ea1aeac3f337b9b01babbfdb106a9" },
  legacyCopy: { schemaVersion: 1, keyCount: 239, sha256: "1d73b4c80ae1025321532ff3be81430a5e43abfa6ca72d6aef8f57dc2da2a307" },
  // style/copy/assets follow this repo's package (a test pins them to the manifest); sourceCommit and tgzSha256 name the tgz NIHO reviewed and pinned.
  style: { id: "niho-experience-presentation/v1/scoped-css", sha256: "bdb9c5a367e992fff22e1af50de8a4730519412cd739a97466028401933d6864" },
  assets: { schemaVersion: 1, sha256: "2ba41a362cbd003319506f1b53ae6b910205304adbd000aab49fca4dce55d7fa" },
} as const);

export type PresentationProvenance = Readonly<{
  schemaVersion: 1;
  renderingMode: "authored" | "code-default";
  presentation: typeof EXPERIENCE_PRESENTATION_IDENTITY | null;
}>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, required: readonly string[]) => {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => keys.includes(key));
};
const same = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && same(left[key], right[key]));
};

export function parsePresentationProvenance(value: unknown): PresentationProvenance {
  if (!isObject(value) || !exactKeys(value, ["schemaVersion", "renderingMode", "presentation"]) || value.schemaVersion !== 1) throw new Error("Invalid presentation provenance");
  if (value.renderingMode === "authored" && value.presentation === null) return { schemaVersion: 1, renderingMode: "authored", presentation: null };
  if (value.renderingMode === "code-default" && same(value.presentation, EXPERIENCE_PRESENTATION_IDENTITY)) return { schemaVersion: 1, renderingMode: "code-default", presentation: EXPERIENCE_PRESENTATION_IDENTITY };
  throw new Error("Unknown presentation identity");
}
