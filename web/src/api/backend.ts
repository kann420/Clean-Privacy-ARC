import { MockBackend } from "./mockBackend";
import type { AccountStatus, Backend } from "./types";
import { UnlinkBrowserBackend } from "./unlinkBackend";

export type BackendEnvironment = {
  VITE_BACKEND_MODE?: string;
  VITE_API_BASE_URL?: string;
};

export function selectBackendMode(
  environment: BackendEnvironment,
): "demo" | "live" {
  const explicit = environment.VITE_BACKEND_MODE?.trim();
  if (explicit === "demo" || explicit === "live") return explicit;
  if (explicit) {
    throw new Error(
      'VITE_BACKEND_MODE must be exactly "demo" or "live".',
    );
  }
  return environment.VITE_API_BASE_URL?.trim() ? "live" : "demo";
}

let sessionBackend: Backend | null = null;

export function createBackend(
  initialStatus: AccountStatus = "none",
  environment: BackendEnvironment = import.meta.env as BackendEnvironment,
): Backend {
  if (sessionBackend) return sessionBackend;
  sessionBackend =
    selectBackendMode(environment) === "live"
      ? new UnlinkBrowserBackend()
      : new MockBackend({ status: initialStatus });
  return sessionBackend;
}

export function resetBackendForTests(): void {
  sessionBackend = null;
}

export const isDemoBackend = (backend: Backend): boolean =>
  backend.mode === "demo";

export type { Backend };
