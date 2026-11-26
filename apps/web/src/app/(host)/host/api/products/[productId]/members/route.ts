import { productMemberSelectionRequest } from "@/lib/experience/member-profile-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, context: { params: Promise<{ productId: string }> }): Promise<Response> {
  return productMemberSelectionRequest(request, (await context.params).productId);
}

export const GET = handle;
export const PUT = handle;
