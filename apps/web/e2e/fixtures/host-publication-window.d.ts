export {};

declare global {
  interface Window {
    mountHostPublication: (adminDraftCreate?: boolean) => void;
  }
}
