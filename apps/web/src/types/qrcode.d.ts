/*
 * The part of `qrcode` (1.5.x, no bundled types) this site uses: the symbol's modules, which
 * src/lib/qr.ts turns into one SVG path. The renderers (canvas, PNG, terminal) stay untyped
 * on purpose so nothing but that path is drawn from an invite URL.
 */
declare module "qrcode" {
  export interface QRCodeModules {
    /** Modules per side, without the quiet zone. */
    size: number;
    /** Row-major, 1 for a dark module. */
    data: Uint8Array;
  }
  export interface QRCodeSymbol {
    modules: QRCodeModules;
    version: number;
  }
  export interface QRCodeCreateOptions {
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    version?: number;
  }
  export function create(text: string, options?: QRCodeCreateOptions): QRCodeSymbol;
}
