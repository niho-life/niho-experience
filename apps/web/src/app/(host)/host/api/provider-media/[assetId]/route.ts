import { providerMediaAssetRequest } from "@/lib/experience/publication-http";

type Context = { params: Promise<{ assetId: string }> };

export const GET = (request: Request, context: Context) => providerMediaAssetRequest(request, context);
export const DELETE = (request: Request, context: Context) => providerMediaAssetRequest(request, context);
