export {};

declare global {
  interface Window {
    mountEmbedBooking: (acceptanceMode: "INSTANT" | "APPROVAL", options?: { layout?: "page" | "embed"; preview?: boolean }) => void;
  }
}
