import { RESERVATION_READER_KEYS } from "./constants.mjs";
import { adapterRegistryKey } from "./driver-registry.mjs";
import { createGygReservationReader } from "./gyg-reservation-reader.mjs";
import { unsupportedReservationReaderFactory } from "./reservation-executor.mjs";

export const RESERVATION_READER_FACTORIES = Object.freeze({
  "GetYourGuide/gyg-browser@1": ({ target, config }) => createGygReservationReader({ target, config }),
});

if (Object.keys(RESERVATION_READER_FACTORIES).join("\n") !== RESERVATION_READER_KEYS.join("\n")) {
  throw new Error("reservation reader registry drift");
}

export { RESERVATION_READER_KEYS };

// A reader runs only when config.reservationReaders lists its adapter key.
// Anything else returns the exact unsupported sentinel, which the executor
// recognises before issuing a read generation or starting a browser.
export function selectReservationReaderFactory({ job, config }) {
  const key = adapterRegistryKey(job.target);
  const enabled = Array.isArray(config?.reservationReaders) && config.reservationReaders.includes(key);
  if (!enabled || !Object.hasOwn(RESERVATION_READER_FACTORIES, key)) return unsupportedReservationReaderFactory;
  return RESERVATION_READER_FACTORIES[key];
}
