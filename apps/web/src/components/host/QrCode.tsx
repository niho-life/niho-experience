"use client";

import { useMemo } from "react";
import { qrSymbol } from "@/lib/qr";

/**
 * A QR code as inline SVG (#181): white ground, ink modules, read by a phone from the screen.
 * `label` is what a screen reader hears instead; the value itself is never written out.
 */
export function QrCode({ value, label, className = "" }: { value: string; label: string; className?: string }) {
  const symbol = useMemo(() => qrSymbol(value), [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${symbol.size} ${symbol.size}`} shapeRendering="crispEdges" className={`block aspect-square ${className}`.trim()}>
      <path d={`M0 0h${symbol.size}v${symbol.size}H0z`} fill="#ffffff" />
      <path d={symbol.path} fill="#1c1c1a" />
    </svg>
  );
}
