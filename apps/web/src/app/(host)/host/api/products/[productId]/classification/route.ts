import { publicationRequest, type PublicationProductContext } from "@/lib/experience/publication-http";

/** 商品の分類 (#529): the product's OWNER reads and sets the category, area, だれと and こんな日に. */
export const GET = (request: Request, context: PublicationProductContext) => publicationRequest(request, context, "readClassification");
export const PUT = (request: Request, context: PublicationProductContext) => publicationRequest(request, context, "saveClassification");
