import { adminMemberProfileRequest } from "@/lib/experience/member-profile-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ providerId: string; memberId: string }> }): Promise<Response> {
  return adminMemberProfileRequest(request, await context.params);
}

export const GET = handle;
export const PUT = handle;
export const POST = handle;
