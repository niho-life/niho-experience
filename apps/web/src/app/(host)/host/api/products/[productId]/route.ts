import { publicationRequest, type PublicationProductContext } from "@/lib/experience/publication-http";

export const GET = (request: Request, context: PublicationProductContext) => publicationRequest(request, context, "read");
export const PATCH = (request: Request, context: PublicationProductContext) => publicationRequest(request, context, "save");
