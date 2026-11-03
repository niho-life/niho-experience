import { noStoreJson } from "@/lib/host/server";
export function POST() { return noStoreJson({ error: "gone" }, 410); }
