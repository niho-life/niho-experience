export type GtagCommand = (...args: unknown[]) => void;

/** Queue Google Tag commands in the arguments-object format consumed by gtag.js. */
export function createGtagQueue(dataLayer: unknown[]): GtagCommand {
  return function (...args: unknown[]) {
    dataLayer.push(arguments);
  };
}
