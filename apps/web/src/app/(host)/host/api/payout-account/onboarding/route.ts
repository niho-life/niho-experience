import type { NextRequest } from "next/server";
import { postPayoutOnboarding } from "@/lib/experience/host-connect-onboarding-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: NextRequest) => postPayoutOnboarding(request);
