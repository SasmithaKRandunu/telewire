/**
 * Post-download action executor and countdown dialogs.
 *
 * Provides safe, cancelable countdowns for Shutdown and Sleep,
 * as well as notification sounds and folder opening.
 */

import type { PostDownloadAction } from "./types";
import * as ipc from "./ipc";
import { icon } from "./icons";
import { el, modal, toast } from "./ui";

const POST_ACTION_KEY = "telewire.post_download_action";

export function getPostDownloadAction(): PostDownloadAction {
  try {
    const val = localStorage.getItem(POST_ACTION_KEY) as PostDownloadAction | null;
    if (val && ["none", "open_folder", "chime", "exit", "sleep", "hibernate", "shutdown"].includes(val)) {
      return val;
    }
  } catch {}
  return "none";
}

export function setPostDownloadAction(action: PostDownloadAction): void {
  try {
    localStorage.setItem(POST_ACTION_KEY, action);
  } catch {}
}

/** Plays a pleasant 3-tone chime using Web Audio API */
export function playCompletionChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const playNote = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.04);
    };

    // C5 (523Hz) -> E5 (659Hz) -> G5 (784Hz)
    playNote(523.25, now, 0.16);
    playNote(659.25, now + 0.14, 0.16);
    playNote(783.99, now + 0.28, 0.32);
  } catch (e) {
    console.warn("Chime playback error:", e);
  }
}

/**
 * Execute the selected post-download action when the queue finishes.
 */
export async function executePostDownloadAction(
  action: PostDownloadAction,
  downloadRoot: string
): Promise<void> {
  switch (action) {
    case "none":
      break;

    case "open_folder":
      toast("Downloads finished — opening folder", "ok");
      if (downloadRoot) {
        try {
          await ipc.openDownloadFolder(downloadRoot);
        } catch {
          await ipc.revealInFolder(downloadRoot);
        }
      }
      break;

    case "chime":
      playCompletionChime();
      toast("All downloads completed!", "ok");
      break;

    case "exit":
      showCountdownModal({
        title: "Downloads Complete",
        message: "TeleWire will close automatically in:",
        seconds: 8,
        glyph: "logout",
        onConfirm: async () => {
          await ipc.exitApp();
        },
        onCancel: () => {
          toast("App exit cancelled", "ok");
        },
      });
      break;

    case "sleep":
      showCountdownModal({
        title: "Downloads Complete",
        message: "Your computer will go to sleep in:",
        seconds: 20,
        glyph: "moon",
        onConfirm: async () => {
          await ipc.sleepComputer();
        },
        onCancel: () => {
          toast("Sleep cancelled", "ok");
        },
      });
      break;

    case "hibernate":
      showCountdownModal({
        title: "Downloads Complete",
        message: "Your computer will hibernate in:",
        seconds: 20,
        glyph: "moon",
        onConfirm: async () => {
          await ipc.hibernateComputer();
        },
        onCancel: () => {
          toast("Hibernation cancelled", "ok");
        },
      });
      break;

    case "shutdown":
      // Issue native Windows shutdown command with 60 second delay
      try {
        await ipc.shutdownComputer(60);
      } catch (e) {
        console.warn("Native shutdown call error:", e);
      }

      showCountdownModal({
        title: "Downloads Complete — Shutting Down",
        message: "Your computer is scheduled to shut down in:",
        seconds: 60,
        glyph: "power",
        onConfirm: async () => {
          // Native command is already running
        },
        onCancel: async () => {
          try {
            await ipc.cancelShutdown();
          } catch (e) {
            console.warn("Cancel shutdown error:", e);
          }
          toast("Shutdown cancelled", "ok");
        },
      });
      break;
  }
}

function showCountdownModal(opts: {
  title: string;
  message: string;
  seconds: number;
  glyph: "power" | "moon" | "logout";
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}): void {
  let remaining = opts.seconds;
  const numEl = el("div.countdown-num", {}, String(remaining));
  const cancelBtn = el("button.btn.btn-primary", { type: "button" }, "Cancel Action") as HTMLButtonElement;

  const body = el("div", {}, [
    el("div.modal-head", {}, [
      el("span", { html: icon(opts.glyph, 24) }),
      el("div.modal-title", {}, [
        el("h2", { id: "countdown-title" }, opts.title),
        el("p.field-hint", {}, opts.message),
      ]),
    ]),
    el("div.countdown-box", {}, [numEl]),
    el("div.modal-foot", {}, [cancelBtn]),
  ]);

  const close = modal(body, { labelledBy: "countdown-title" });
  let disarmed = false;

  const timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(timer);
      if (!disarmed) {
        disarmed = true;
        close();
        void opts.onConfirm();
      }
    } else {
      numEl.textContent = String(remaining);
    }
  }, 1000);

  cancelBtn.addEventListener("click", () => {
    clearInterval(timer);
    if (!disarmed) {
      disarmed = true;
      close();
      opts.onCancel();
    }
  });
}
