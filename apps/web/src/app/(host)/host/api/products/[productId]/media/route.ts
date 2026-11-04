import { publicationMediaRequest, type PublicationProductContext } from "@/lib/experience/publication-http";

export const POST = (request: Request, context: PublicationProductContext) => publicationMediaRequest(request, context);
