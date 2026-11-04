import { readPublicationMedia, type PublicationProductContext } from "@/lib/experience/publication-http";

type Context = PublicationProductContext & { params: Promise<{ productId: string; assetId: string }> };

export const GET = (request: Request, context: Context) => readPublicationMedia(request, context);
