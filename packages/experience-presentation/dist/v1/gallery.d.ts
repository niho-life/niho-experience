import { type Ref } from "react";
import { type StaticCopyAccessorV1 } from "./static-copy.js";
import { type DetailGalleryModelV1, type PresentationPrimitivesV1 } from "./types.js";
export declare function MobileGalleryViewV1({ model, index, onPositionChange, onPhotoClick, primitives, copy }: {
    model: DetailGalleryModelV1;
    index?: number;
    onPositionChange?: (index: number) => void;
    onPhotoClick?: () => void;
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element;
export declare function DesktopGalleryViewV1({ model, dialogRef, dialogOpen, onOpen, onClose, primitives, copy }: {
    model: DetailGalleryModelV1;
    dialogRef?: Ref<HTMLDialogElement>;
    dialogOpen?: boolean;
    onOpen?: () => void;
    onClose?: () => void;
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
}): import("react").JSX.Element | null;
export declare function DetailGalleryV1({ model, primitives, copy, previewDialogOpen }: {
    model: DetailGalleryModelV1;
    primitives?: Partial<PresentationPrimitivesV1>;
    copy?: StaticCopyAccessorV1;
    previewDialogOpen?: boolean;
}): import("react").JSX.Element;
