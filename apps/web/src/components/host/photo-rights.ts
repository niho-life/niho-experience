export type PhotoMediaPlacement = "GALLERY" | "PROVIDER_PHOTO" | "BUSINESS_LOGO";

/** Permission applies to this selected file and the public use the host reviewed. */
export type PhotoRightsConfirmation<T extends object> = {
  readonly file: T;
  readonly productId: string;
  readonly placement: PhotoMediaPlacement;
};

export function photoRightsConfirmed<T extends object>(
  confirmation: PhotoRightsConfirmation<T> | null,
  file: T | null,
  productId: string | null,
  placement: PhotoMediaPlacement,
): boolean {
  return file !== null && productId !== null && confirmation !== null
    && confirmation.file === file
    && confirmation.productId === productId
    && confirmation.placement === placement;
}
