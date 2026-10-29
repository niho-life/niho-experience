import { create } from "qrcode";

/** A QR symbol as one SVG path: `viewBox="0 0 size size"`, dark modules in `path`, a 4-module quiet zone around them. */
export interface QrSymbol {
  size: number;
  path: string;
}

const QUIET_ZONE = 4;

/**
 * The QR code of a value (an invite URL, #181) drawn by the browser as inline SVG, so the
 * value never leaves the page as an image request. Error correction M, the usual for a URL
 * read from a phone's screen. Runs of dark modules in a row become one rectangle each.
 */
export function qrSymbol(value: string): QrSymbol {
  const { modules } = create(value, { errorCorrectionLevel: "M" });
  const side = modules.size;
  let path = "";
  for (let row = 0; row < side; row += 1) {
    let run = 0;
    for (let column = 0; column <= side; column += 1) {
      const dark = column < side && modules.data[row * side + column] === 1;
      if (dark) {
        run += 1;
      } else if (run > 0) {
        path += `M${column - run + QUIET_ZONE} ${row + QUIET_ZONE}h${run}v1h-${run}z`;
        run = 0;
      }
    }
  }
  return { size: side + QUIET_ZONE * 2, path };
}
