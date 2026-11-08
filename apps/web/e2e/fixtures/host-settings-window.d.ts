export {};

declare global {
  interface Window {
    mountHostGuard: (fingerprint: string) => void;
    mountHostTeam: (providerId: string) => void;
  }
}
