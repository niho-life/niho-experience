import { publicationMediaRequest, publicationMediaSelectionRequest, type PublicationProductContext } from "@/lib/experience/publication-http";

export const POST = (request: Request, context: PublicationProductContext) => publicationMediaRequest(request, context);
export const PUT = (request: Request, context: PublicationProductContext) => publicationMediaSelectionRequest(request, context);
