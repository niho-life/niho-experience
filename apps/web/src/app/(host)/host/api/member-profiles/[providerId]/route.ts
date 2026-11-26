import { hostMemberProfileRequest } from "@/lib/experience/member-profile-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ providerId: string }> }): Promise<Response> {
  return hostMemberProfileRequest(request, (await context.params).providerId);
}

export const GET = handle;
export const PUT = handle;
export const POST = handle;
