export {};

declare global {
  interface Window {
    mountEmbedBooking: (acceptanceMode: "INSTANT" | "APPROVAL") => void;
  }
}
