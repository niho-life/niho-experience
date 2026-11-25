export {};

declare global {
  interface Window {
    mountHostPublication: (adminDraftCreate?: boolean, host?: "list" | "create") => void;
  }
}
