export type GtagCommand = (...args: unknown[]) => void;

/** Queue Google Tag commands in the arguments-object format consumed by gtag.js. */
export function createGtagQueue(dataLayer: unknown[]): GtagCommand {
  return function gtag() {
    // gtag.js consumes Google's documented native Arguments object here.
    // eslint-disable-next-line prefer-rest-params
    dataLayer.push(arguments);
  };
}
