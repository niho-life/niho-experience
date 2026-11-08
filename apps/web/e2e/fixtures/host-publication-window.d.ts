export {};

declare global {
  interface Window {
    mountHostPublication: () => void;
  }
}
