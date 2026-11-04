export type SellerKind = "PERSON" | "BUSINESS";

export type SellerDisclosure = {
  readonly version: number;
  readonly method: "NATIVE" | "EXTERNAL" | "WITHDRAWN";
  readonly sellerKind: SellerKind;
  readonly sellerDisplayName: string;
  readonly representativeName: string | null;
  readonly publicAddress: string | null;
  readonly publicPhone: string | null;
  readonly publicEmail: string | null;
  readonly externalUrl: string | null;
  readonly consentVersion: string;
  readonly consentedAtUtc: string;
  readonly withdrawnAtUtc: string | null;
};

export type PendingSellerCommand = {
  readonly method: "PUT" | "DELETE";
  readonly expectedDisclosureMethod: SellerDisclosure["method"];
  /** Frozen wire bytes. Unknown-result retries must reuse these bytes and commandId. */
  readonly serializedBody: string;
};

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: JsonObject, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const optionalText = (value: unknown): value is string | null => value === null || typeof value === "string";
const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function parseSellerMutationResponse(value: unknown): SellerDisclosure | null {
  if (!isObject(value) || !exactKeys(value, ["disclosure"]) || !isObject(value.disclosure)) return null;
  const disclosure = value.disclosure;
  if (!exactKeys(disclosure, [
    "version", "method", "sellerKind", "sellerDisplayName", "representativeName", "publicAddress", "publicPhone",
    "publicEmail", "externalUrl", "consentVersion", "consentedAtUtc", "withdrawnAtUtc",
  ])) return null;
  if (!Number.isSafeInteger(disclosure.version) || Number(disclosure.version) < 1
    || (disclosure.method !== "NATIVE" && disclosure.method !== "EXTERNAL" && disclosure.method !== "WITHDRAWN")
    || (disclosure.sellerKind !== "PERSON" && disclosure.sellerKind !== "BUSINESS")
    || typeof disclosure.sellerDisplayName !== "string" || disclosure.sellerDisplayName.length < 1
    || typeof disclosure.consentVersion !== "string" || disclosure.consentVersion.length < 1
    || !instant(disclosure.consentedAtUtc) || !optionalText(disclosure.representativeName)
    || !optionalText(disclosure.publicAddress) || !optionalText(disclosure.publicPhone)
    || !optionalText(disclosure.publicEmail) || !optionalText(disclosure.externalUrl)) return null;

  if (disclosure.method === "NATIVE") {
    if (typeof disclosure.publicAddress !== "string" || disclosure.publicAddress.length < 1
      || typeof disclosure.publicPhone !== "string" || disclosure.publicPhone.length < 1
      || typeof disclosure.publicEmail !== "string" || disclosure.publicEmail.length < 1
      || disclosure.externalUrl !== null || disclosure.withdrawnAtUtc !== null
      || (disclosure.sellerKind === "BUSINESS" ? typeof disclosure.representativeName !== "string" || disclosure.representativeName.length < 1 : disclosure.representativeName !== null)) return null;
  } else if (disclosure.method === "EXTERNAL") {
    if (disclosure.representativeName !== null || disclosure.publicAddress !== null || disclosure.publicPhone !== null
      || disclosure.publicEmail !== null || typeof disclosure.externalUrl !== "string" || !disclosure.externalUrl.startsWith("https://")
      || disclosure.withdrawnAtUtc !== null) return null;
  } else if (disclosure.representativeName !== null || disclosure.publicAddress !== null || disclosure.publicPhone !== null
    || disclosure.publicEmail !== null || disclosure.externalUrl !== null || !instant(disclosure.withdrawnAtUtc)) return null;

  return disclosure as SellerDisclosure;
}

export function beginSellerCommand(
  existing: PendingSellerCommand | null,
  method: PendingSellerCommand["method"],
  bodyWithoutCommandId: JsonObject,
  createCommandId: () => string,
): { readonly command: PendingSellerCommand; readonly created: boolean } {
  if (existing) return { command: existing, created: false };
  const expectedDisclosureMethod = method === "DELETE"
    ? "WITHDRAWN"
    : isObject(bodyWithoutCommandId.disclosure) && (bodyWithoutCommandId.disclosure.method === "NATIVE" || bodyWithoutCommandId.disclosure.method === "EXTERNAL")
      ? bodyWithoutCommandId.disclosure.method
      : null;
  if (!expectedDisclosureMethod) throw new TypeError("Seller save command requires a known disclosure method.");
  return {
    command: { method, expectedDisclosureMethod, serializedBody: JSON.stringify({ commandId: createCommandId(), ...bodyWithoutCommandId }) },
    created: true,
  };
}

export type SellerCommandOutcome =
  | { readonly kind: "CONFIRMED"; readonly disclosure: SellerDisclosure }
  | { readonly kind: "AUTH_REJECTED" }
  | { readonly kind: "REJECTED" }
  | { readonly kind: "UNKNOWN" };

export function sellerCommandOutcome(
  status: number,
  value: unknown,
  expectedDisclosureMethod?: SellerDisclosure["method"],
): SellerCommandOutcome {
  if (status === 200) {
    const disclosure = parseSellerMutationResponse(value);
    return disclosure && (!expectedDisclosureMethod || disclosure.method === expectedDisclosureMethod)
      ? { kind: "CONFIRMED", disclosure }
      : { kind: "UNKNOWN" };
  }
  if (status === 401 || status === 403) return { kind: "AUTH_REJECTED" };
  if (status === 400 || status === 409 || status === 413 || status === 422) return { kind: "REJECTED" };
  return { kind: "UNKNOWN" };
}

export function pendingSellerCommandAfter(
  command: PendingSellerCommand,
  outcome: SellerCommandOutcome,
): PendingSellerCommand | null {
  return outcome.kind === "UNKNOWN" ? command : null;
}
