import { createGygDriver } from "./gyg-driver.mjs";
import { createViatorDriver } from "./viator-driver.mjs";
import { createJalanDriver } from "./jalan-driver.mjs";
import { ContractError } from "./validation.mjs";

const DRIVERS = Object.freeze({
  "GetYourGuide/gyg-browser@1": createGygDriver,
  "Viator/viator-browser@1": createViatorDriver,
  "Jalan/jalan-browser@1": createJalanDriver,
});

export function adapterRegistryKey(target) { return `${target.site}/${target.adapter}@${target.adapterVersion}`; }

export function selectDriverFactory({ job, ...options }) {
  const driver = DRIVERS[adapterRegistryKey(job.target)];
  if (!driver) throw new ContractError("UNSUPPORTED_TARGET");
  return driver({ job, ...options });
}

export const DRIVER_REGISTRY_KEYS = Object.freeze(Object.keys(DRIVERS));
