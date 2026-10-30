export class StoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreError";
  }
}

export class StoreAccessDeniedError extends StoreError {
  constructor() {
    super("The active provider membership required for this operation was not found.");
    this.name = "StoreAccessDeniedError";
  }
}

export class StoreNotFoundError extends StoreError {
  constructor(resource: string) {
    super(`${resource} was not found in the requested provider scope.`);
    this.name = "StoreNotFoundError";
  }
}

export class StoreConflictError extends StoreError {
  constructor(message: string) {
    super(message);
    this.name = "StoreConflictError";
  }
}

export class StoreValidationError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreValidationError";
  }
}

/** Too many requests in a window; the caller may try again after `retryAfterSeconds`. */
export class StoreRateLimitedError extends StoreError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many requests were made in the current window.");
    this.name = "StoreRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The store's subset of NIHO's PublicExperienceCheckoutErrorCode (VALIDATION_ERROR and CHECKOUT_UNAVAILABLE belong to the route). */
export type GuestCheckoutErrorCode =
  | "INPUT_INVALID"
  | "CONSENT_OUTDATED"
  | "OCCURRENCE_INVALID"
  | "ANSWERS_INVALID"
  | "UNAVAILABLE"
  | "FULL"
  | "HOLD_LIMIT"
  | "REQUEST_MISMATCH"
  | "QUESTIONS_CHANGED"
  | "PRICE_CHANGED"
  | "RATE_LIMITED";

export type GuestCheckoutOccurrenceReason = "NOT_SCHEDULED" | "CUTOFF" | "UNAVAILABLE";

export interface GuestCheckoutErrorDetails {
  readonly field?: string;
  readonly questionId?: string;
  readonly seatsLeft?: number;
  readonly currentTotalYen?: number;
  readonly occurrenceReason?: GuestCheckoutOccurrenceReason;
  readonly retryAfterSeconds?: number;
}

/**
 * A refused guest checkout, carrying the fields of NIHO's PublicExperienceCheckoutError so the public
 * route can answer with the same body. The message names the code and field only, never what the
 * guest entered. `retryAfterSeconds` is for the route's Retry-After header (RATE_LIMITED).
 */
export class GuestCheckoutError extends StoreError {
  readonly code: GuestCheckoutErrorCode;
  readonly field: string | null;
  readonly questionId: string | null;
  readonly seatsLeft: number | null;
  readonly currentTotalYen: number | null;
  readonly occurrenceReason: GuestCheckoutOccurrenceReason | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(code: GuestCheckoutErrorCode, details: GuestCheckoutErrorDetails = {}) {
    super(`Guest checkout was refused: ${code}${details.field === undefined ? "" : ` (${details.field})`}.`);
    this.name = "GuestCheckoutError";
    this.code = code;
    this.field = details.field ?? null;
    this.questionId = details.questionId ?? null;
    this.seatsLeft = details.seatsLeft ?? null;
    this.currentTotalYen = details.currentTotalYen ?? null;
    this.occurrenceReason = details.occurrenceReason ?? null;
    // As NIHO: only RATE_LIMITED may be sent again with the same key and content.
    this.retryable = code === "RATE_LIMITED";
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
  }
}

export class BookingUnavailableError extends StoreError {
  readonly reason: string;
  readonly availableSeats: number;

  constructor(reason: string, availableSeats: number) {
    super(`The requested occurrence is not bookable: ${reason}.`);
    this.name = "BookingUnavailableError";
    this.reason = reason;
    this.availableSeats = availableSeats;
  }
}
