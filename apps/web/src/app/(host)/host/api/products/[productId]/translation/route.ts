import { publicationTranslationRequest, type PublicationProductContext } from "@/lib/experience/publication-http";

export const runtime = "nodejs";

export const POST = (request: Request, context: PublicationProductContext) => publicationTranslationRequest(request, context);
