/**
 * Typed wrappers over the Tauri command bridge.
 *
 * Every backend call goes through `call()`, which normalises errors: Rust
 * returns `Result<T, String>` and Tauri rejects with that string, but a
 * transport failure rejects with an Error. Callers should only ever see a
 * `IpcError` carrying a message that is safe to display.
 *
 * When the frontend is served outside Tauri (`npm run dev` in a browser), the
 * bridge is absent. Rather than throwing on every call, we fall back to the
 * fixture backend in `demo.ts` so the interface can be developed and reviewed
 * without a Telegram account. `isDemo()` is surfaced in the UI so a demo build
 * is never mistaken for the real thing.
 */

import type {
  AuthState,
  ChannelInfo,
  GrabLinkResult,
  Job,
  MediaFilter,
  MediaPage,
  Settings,
} from "./types";

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window ||
      "__TAURI__" in window ||
      Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__))
  );
}

export const isDemo = (): boolean => !isTauri();

export class IpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcError";
  }
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>;

let invokeImpl: Invoke | undefined;
let listenImpl: Listen | undefined;

async function bridge(): Promise<void> {
  if (invokeImpl && listenImpl) return;
  if (isTauri()) {
    const [core, event] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]);
    invokeImpl = core.invoke as Invoke;
    listenImpl = event.listen as unknown as Listen;
  } else {
    const demo = await import("./demo");
    invokeImpl = demo.invoke;
    listenImpl = demo.listen;
  }
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await bridge();
  try {
    return (await invokeImpl!(cmd, args)) as T;
  } catch (e) {
    // Rust `Err(String)` arrives as a bare string; anything else is a genuine
    // transport/panic failure and we keep its message.
    const msg =
      typeof e === "string"
        ? e
        : e instanceof Error
          ? e.message
          : "Unexpected backend failure";
    throw new IpcError(msg);
  }
}

export async function on<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  await bridge();
  return listenImpl!(event, (e) => cb(e.payload as T));
}

/* ---------- auth --------------------------------------------------------- */

export const getAuthState = () => call<AuthState>("get_auth_state");

export const saveCredentials = (apiId: number, apiHash: string) =>
  call<AuthState>("save_credentials", { apiId, apiHash });

export const loginStart = (phone: string) => call<AuthState>("login_start", { phone });

export const loginSubmitCode = (code: string) =>
  call<AuthState>("login_submit_code", { code });

export const loginSubmitPassword = (password: string) =>
  call<AuthState>("login_submit_password", { password });

export const logout = () => call<AuthState>("logout");

/* ---------- channels ----------------------------------------------------- */

export const listDialogs = () => call<ChannelInfo[]>("list_dialogs");

export const resolveChannel = (query: string) =>
  call<ChannelInfo>("resolve_channel", { query });

export const grabTelegramLink = (link: string) =>
  call<GrabLinkResult>("grab_telegram_link", { link });

/** Lazily fetched per visible rail row; the backend caches the result. */
export const getChatPhoto = (channelId: number) =>
  call<string | null>("get_chat_photo", { channelId });

export const listMedia = (
  channelId: number,
  offsetId: number,
  limit: number,
  filter: MediaFilter
) => call<MediaPage>("list_media", { channelId, offsetId, limit, filter });

/* ---------- downloads ---------------------------------------------------- */

export const enqueueDownload = (
  channelId: number,
  messageIds: number[],
  startNow: boolean = true
) => call<Job[]>("enqueue_download", { channelId, messageIds, startNow });

export const pauseDownload = (jobId: string) => call<void>("pause_download", { jobId });
export const resumeDownload = (jobId: string) => call<void>("resume_download", { jobId });
export const pauseAllDownloads = () => call<void>("pause_all_downloads");
export const resumeAllDownloads = () => call<void>("resume_all_downloads");
export const cancelDownload = (jobId: string) => call<void>("cancel_download", { jobId });
export const retryDownload = (jobId: string) => call<void>("retry_download", { jobId });
export const reorderDownloads = (newOrder: string[]) =>
  call<Job[]>("reorder_downloads", { newOrder });
export const moveDownload = (jobId: string, direction: "up" | "down" | "top" | "bottom") =>
  call<Job[]>("move_download", { jobId, direction });
export const listJobs = () => call<Job[]>("list_jobs");
export const clearFinished = () => call<void>("clear_finished");
export const clearAllDownloads = () => call<void>("clear_all_downloads");

/* ---------- system ------------------------------------------------------- */

export const getSettings = () => call<Settings>("get_settings");
export const setSettings = (settings: Settings) => call<Settings>("set_settings", { settings });
export const pickDirectory = () => call<string | null>("pick_directory");
export const revealInFolder = (path: string) => call<void>("reveal_in_folder", { path });
export const openDownloadFolder = (path: string) => call<void>("open_download_folder", { path });
export const shutdownComputer = (delaySeconds?: number) =>
  call<void>("shutdown_computer", { delaySeconds });
export const cancelShutdown = () => call<void>("cancel_shutdown");
export const sleepComputer = () => call<void>("sleep_computer");
export const hibernateComputer = () => call<void>("hibernate_computer");
export const exitApp = () => call<void>("exit_app");
export const openUrl = (url: string) => call<void>("open_url", { url });

/* ---------- events ------------------------------------------------------- */

export const EV = {
  progress: "telewire://progress",
  job: "telewire://job",
  auth: "telewire://auth",
} as const;
