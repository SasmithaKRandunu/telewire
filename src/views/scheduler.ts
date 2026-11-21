/**
 * Download scheduler controller & modal.
 *
 * Allows users to schedule when transfers start and/or pause.
 * Runs on a 1-second interval to check target triggers and update status readouts.
 */

import { icon } from "../lib/icons";
import { el, modal, toast } from "../lib/ui";

export interface SchedulerConfig {
  enabled: boolean;
  startMode: "time" | "delay";
  startTime: string; // "HH:MM" 24h
  delayMinutes: number;
  stopEnabled: boolean;
  stopTime: string; // "HH:MM" 24h
  targetStartMs: number | null;
  targetStopMs: number | null;
  startTriggered: boolean;
  stopTriggered: boolean;
}

const STORAGE_KEY = "telewire.scheduler_config";

export function loadSchedulerConfig(): SchedulerConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SchedulerConfig>;
      return {
        enabled: Boolean(parsed.enabled),
        startMode: parsed.startMode === "delay" ? "delay" : "time",
        startTime: parsed.startTime || "02:00",
        delayMinutes: Number(parsed.delayMinutes) || 30,
        stopEnabled: Boolean(parsed.stopEnabled),
        stopTime: parsed.stopTime || "06:00",
        targetStartMs: parsed.targetStartMs ?? null,
        targetStopMs: parsed.targetStopMs ?? null,
        startTriggered: Boolean(parsed.startTriggered),
        stopTriggered: Boolean(parsed.stopTriggered),
      };
    }
  } catch {}

  return {
    enabled: false,
    startMode: "time",
    startTime: "02:00",
    delayMinutes: 30,
    stopEnabled: false,
    stopTime: "06:00",
    targetStartMs: null,
    targetStopMs: null,
    startTriggered: false,
    stopTriggered: false,
  };
}

export function saveSchedulerConfig(cfg: SchedulerConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {}
}

/** Calculate the next timestamp for a given HH:MM string */
export function nextTimeMs(hhmm: string): number {
  const parts = hhmm.split(":");
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

/** Format milliseconds delta into human readable "1h 23m" or "45s" */
export function formatDelta(ms: number): string {
  if (ms <= 0) return "now";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function openSchedulerModal(
  current: SchedulerConfig,
  onSave: (next: SchedulerConfig) => void
): void {
  const draft: SchedulerConfig = { ...current };

  const enabledSwitch = el("input", { type: "checkbox", checked: draft.enabled }) as HTMLInputElement;

  const modeTimeRadio = el("input", {
    type: "radio",
    name: "sched-start-mode",
    value: "time",
    checked: draft.startMode === "time",
  }) as HTMLInputElement;

  const modeDelayRadio = el("input", {
    type: "radio",
    name: "sched-start-mode",
    value: "delay",
    checked: draft.startMode === "delay",
  }) as HTMLInputElement;

  const timeInput = el("input.input", {
    type: "time",
    value: draft.startTime,
    style: "max-width: 130px",
  }) as HTMLInputElement;

  const delayInput = el("input.input", {
    type: "number",
    min: "1",
    max: "1440",
    value: String(draft.delayMinutes),
    style: "max-width: 90px",
  }) as HTMLInputElement;

  const stopEnabledSwitch = el("input", {
    type: "checkbox",
    checked: draft.stopEnabled,
  }) as HTMLInputElement;

  const stopTimeInput = el("input.input", {
    type: "time",
    value: draft.stopTime,
    style: "max-width: 130px",
  }) as HTMLInputElement;

  const syncControls = () => {
    const isEnabled = enabledSwitch.checked;
    modeTimeRadio.disabled = !isEnabled;
    modeDelayRadio.disabled = !isEnabled;
    timeInput.disabled = !isEnabled || !modeTimeRadio.checked;
    delayInput.disabled = !isEnabled || !modeDelayRadio.checked;
    stopEnabledSwitch.disabled = !isEnabled;
    stopTimeInput.disabled = !isEnabled || !stopEnabledSwitch.checked;
  };

  enabledSwitch.addEventListener("change", syncControls);
  modeTimeRadio.addEventListener("change", syncControls);
  modeDelayRadio.addEventListener("change", syncControls);
  stopEnabledSwitch.addEventListener("change", syncControls);
  syncControls();

  const cancelBtn = el("button.btn.btn-ghost", { type: "button" }, "Cancel") as HTMLButtonElement;
  const disableBtn = el("button.btn.btn-danger", { type: "button" }, "Turn Off") as HTMLButtonElement;
  disableBtn.hidden = !draft.enabled;

  const saveBtn = el("button.btn.btn-primary", { type: "button" }, "Save Schedule") as HTMLButtonElement;

  const body = el("div", {}, [
    el("div.modal-head", {}, [
      el("span", { html: icon("clock", 20) }),
      el("div.modal-title", {}, [
        el("h2", { id: "sched-title" }, "Download Scheduler"),
        el("p.field-hint", {}, "Schedule transfers to start and stop automatically."),
      ]),
    ]),

    el("div.auth-form", {}, [
      el("label.switch", {}, [
        enabledSwitch,
        el("span", {}, [
          el("div", {}, "Enable Scheduler"),
          el("div.field-hint", {}, "Automatically manage transfer execution on a schedule."),
        ]),
      ]),

      el("div.field", {}, [
        el("label", {}, "Start downloads"),
        el("div.sched-mode-row", {}, [
          modeTimeRadio,
          el("span", {}, "At specific time:"),
          timeInput,
        ]),
        el("div.sched-mode-row", {}, [
          modeDelayRadio,
          el("span", {}, "In countdown:"),
          delayInput,
          el("span.field-hint", {}, "minutes"),
        ]),
      ]),

      el("div.field", {}, [
        el("label.switch", {}, [
          stopEnabledSwitch,
          el("span", {}, [
            el("div", {}, "Automatically pause transfers"),
            el("div.field-hint", {}, "Pause active downloads when this time arrives."),
          ]),
        ]),
        el("div.sched-mode-row", {}, [
          el("span", {}, "Pause at:"),
          stopTimeInput,
        ]),
      ]),
    ]),

    el("div.modal-foot", {}, [disableBtn, cancelBtn, saveBtn]),
  ]);

  const close = modal(body, { labelledBy: "sched-title" });
  cancelBtn.addEventListener("click", close);

  disableBtn.addEventListener("click", () => {
    const next: SchedulerConfig = {
      ...draft,
      enabled: false,
      targetStartMs: null,
      targetStopMs: null,
      startTriggered: false,
      stopTriggered: false,
    };
    saveSchedulerConfig(next);
    onSave(next);
    toast("Scheduler disabled", "ok");
    close();
  });

  saveBtn.addEventListener("click", () => {
    const isEnabled = enabledSwitch.checked;
    const startMode = modeDelayRadio.checked ? "delay" : "time";
    const startTime = timeInput.value || "02:00";
    const delayMinutes = Math.max(1, Number(delayInput.value) || 30);
    const stopEnabled = stopEnabledSwitch.checked;
    const stopTime = stopTimeInput.value || "06:00";

    let targetStartMs: number | null = null;
    let targetStopMs: number | null = null;

    if (isEnabled) {
      if (startMode === "time") {
        targetStartMs = nextTimeMs(startTime);
      } else {
        targetStartMs = Date.now() + delayMinutes * 60 * 1000;
      }
      if (stopEnabled) {
        targetStopMs = nextTimeMs(stopTime);
      }
    }

    const next: SchedulerConfig = {
      enabled: isEnabled,
      startMode,
      startTime,
      delayMinutes,
      stopEnabled,
      stopTime,
      targetStartMs,
      targetStopMs,
      startTriggered: false,
      stopTriggered: false,
    };

    saveSchedulerConfig(next);
    onSave(next);
    if (isEnabled) {
      toast("Scheduler armed and active", "ok");
    }
    close();
  });
}
