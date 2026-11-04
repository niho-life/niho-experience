import { publicationRequest, type PublicationProductContext } from "@/lib/experience/publication-http";

export const POST = (request: Request, context: PublicationProductContext) => publicationRequest(request, context, "stop");
