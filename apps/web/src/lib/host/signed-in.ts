import "server-only";
import { cookies } from "next/headers";
import { readExperienceHostSession } from "./accounts";
import { ACCOUNT_SESSION_COOKIE } from "./session";

/**
 * Whether this browser holds a live Experience host session (#562: the public header shows 「ホスト画面」 instead of 「ホストの方」).
 * It reads the sealed session cookie the host console already uses, shows nothing about the account, and any failure reads as
 * signed out: the public header never breaks because of it.
 */
export async function hostSignedIn(): Promise<boolean> {
  try {
    const token = (await cookies()).get(ACCOUNT_SESSION_COOKIE)?.value;
    if (!token) return false;
    return (await readExperienceHostSession(token)) !== null;
  } catch {
    return false;
  }
}
