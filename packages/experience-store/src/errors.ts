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
