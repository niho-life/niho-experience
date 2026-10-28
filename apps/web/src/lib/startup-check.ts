import { isVapidKeyPair } from "@niho-experience/web-push";
import { resolveConfig } from "./resolve-config";

/** Exits the Node server when the runtime settings are unusable, so the revision never becomes ready. */
export function checkConfigAtStartup(env: Record<string, string | undefined> = process.env) {
  try {
    const config = resolveConfig(env);
    // resolve-config stays runtime-neutral; whether the two VAPID keys belong together needs node:crypto (#177).
    if (config.hostPushEnabled && config.apiMode === "http" && !isVapidKeyPair(config.hostPushVapidPublicKey, config.hostPushVapidPrivateKey)) {
      throw new Error("HOST_PUSH_VAPID_PUBLIC_KEY and HOST_PUSH_VAPID_PRIVATE_KEY are not one key pair");
    }
  } catch (error) {
    console.error(`[config] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
