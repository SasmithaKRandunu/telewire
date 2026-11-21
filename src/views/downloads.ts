/**
 * Downloads view — the transfer queue.
 *
 * Two paths run through here and they have very different budgets:
 *
 *   render(jobs)        cold. Reconciles the job list against a Map keyed by
 *                       id — create / update / remove — because rebuilding the
 *                       list would reset the scroll position and blow away
 *                       whatever button the user had focused.
 *   applyProgress(b)    hot, every ~400ms while anything moves. It may only
 *                       write `style.width` and `textContent` on nodes that
 *                       already exist. No node creation, no attribute churn,
 *                       and no layout reads inside the loop.
 *
 * Filenames and backend error strings are attacker-influenced, so they only
 * ever go in through `textContent`; `html:` carries our own icon SVG.
 */

import type { Job, JobState, MediaKind, PostDownloadAction, ProgressBatch } from "../lib/types";
import { bytes, duration, percent, speed } from "../lib/format";
import { icon, kindIcon, type IconName } from "../lib/icons";
import { el, reducedMotion, toast } from "../lib/ui";
import {
  formatDelta,
  loadSchedulerConfig,
  openSchedulerModal,
  saveSchedulerConfig,
} from "./scheduler";
import { getPostDownloadAction, setPostDownloadAction } from "../lib/postAction";

/** Matches the `land` keyframe window in the stylesheet, with a little slack. */
const JUST_DONE_MS = 700;

export interface DownloadsView {
  el: HTMLElement;
  render(jobs: Job[]): void;
  applyProgress(batch: ProgressBatch): void;
  destroy(): void;
}

/** A live `.job` plus the values last written into it. Comparing before
 *  writing keeps the 400ms tick down to the cells that actually moved. */
interface JobRow {
  node: HTMLElement;
  iconEl: HTMLElement;
  nameEl: HTMLElement;
  channelEl: HTMLElement;
  statusPill: HTMLElement;
  fill: HTMLElement;
  sizes: HTMLElement;
  spd: HTMLElement;
  eta: HTMLElement;
  conns: HTMLElement;
  workersEl: HTMLElement;
  workerFills: HTMLElement[];
  errEl: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
  /** Authoritative size; progress batches carry `done` but not `size`. */
  size: number;
  state: JobState | null;
  kind: MediaKind | null;
  name: string;
  channel: string;
  errText: string;
  vFill: string;
  vSizes: string;
  vSpd: string;
  vEta: string;
  vConns: string;
  /** "connecting" while a running job has yet to receive its first byte. */
  vPhase: string;
  vWorkers: string[];
}

/** `Job` has no `kind`, so the icon is inferred from the extension. Wrong
 *  guesses cost nothing but a glyph. */
const VIDEO = /\.(mp4|mkv|mov|avi|webm|m4v|mpe?g|ts|wmv|flv)$/i;
const AUDIO = /\.(mp3|m4a|flac|ogg|opus|wav|aac|wma)$/i;
const PHOTO = /\.(jpe?g|png|gif|webp|bmp|heic|heif|tiff?|avif)$/i;

function kindOf(name: string): MediaKind {
  if (VIDEO.test(name)) return "video";
  if (AUDIO.test(name)) return "audio";
  if (PHOTO.test(name)) return "photo";
  return "document";
}

/** done / cancelled / error are what `clear_finished` reaps on the Rust side. */
const isFinished = (s: JobState): boolean =>
  s === "done" || s === "cancelled" || s === "error";

export function createDownloads(opts: {
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onReveal: (path: string) => void;
  onClearFinished: () => void;
  onClearQueue: () => void;
  onMove: (id: string, direction: "up" | "down" | "top" | "bottom") => void;
  onReorder: (newOrder: string[]) => void;
}): DownloadsView {
  const rows = new Map<string, JobRow>();
  const doneTimers = new Map<string, number>();
  let dead = false;
  let currentJobs: Job[] = [];

  /* Aggregate. render() owns it while nothing is moving; applyProgress()
     overwrites it on every tick, which is the only source accurate to the
     sampling window. */
  let activeCount = 0;
  let totalBps = 0;

  /* ---------- chrome ----------------------------------------------------- */

  const aggEl = el<"div">("div.toolbar-sub", { text: "0 active · 0 B/s" });
  
  const pauseAllBtn = el<"button">("button.btn.btn-ghost", {
    type: "button",
    disabled: true,
    title: "Pause all active and queued transfers",
    "aria-label": "Pause all transfers",
  }, [
    el<"span">("span", { html: icon("pause", 14) }),
    el<"span">("span", { text: "Pause all" }),
  ]);

  // "Start all" is the explicit trigger for a held queue: it arms every
  // queued job and resumes every paused one, in order, up to the concurrency
  // limit. Without it a queue filled by "Add to Queue" would wait forever.
  const resumeAllBtn = el<"button">("button.btn.btn-ghost", {
    type: "button",
    disabled: true,
    title: "Start every queued and paused download, in queue order",
    "aria-label": "Start all downloads",
  }, [
    el<"span">("span", { html: icon("play", 14) }),
    el<"span">("span", { text: "Start all" }),
  ]);

  type QueueSort = "default" | "name" | "size" | "status";
  let currentSort: QueueSort = "default";
  const sortLabels: Record<QueueSort, string> = {
    default: "Queue order",
    name: "Name (A-Z)",
    size: "Size (Largest)",
    status: "Status",
  };
  const sortText = el<"span">("span", { text: sortLabels[currentSort] });
  const sortBtn = el<"button">("button.btn.btn-ghost.queue-sort-btn", {
    type: "button",
    title: "Sort queue: Click to change sort order",
    "aria-label": "Sort queue",
  }, [
    el<"span">("span", { html: icon("arrowUpDown", 14) }),
    sortText,
  ]);

  sortBtn.addEventListener("click", () => {
    const modes: QueueSort[] = ["default", "name", "size", "status"];
    const nextIdx = (modes.indexOf(currentSort) + 1) % modes.length;
    currentSort = modes[nextIdx] ?? "default";
    sortText.textContent = sortLabels[currentSort];
    
    if (currentJobs.length <= 1) return;
    const sorted = [...currentJobs];
    if (currentSort === "name") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (currentSort === "size") {
      sorted.sort((a, b) => b.size - a.size);
    } else if (currentSort === "status") {
      const rank: Record<JobState, number> = {
        running: 0,
        queued: 1,
        paused: 2,
        error: 3,
        done: 4,
        cancelled: 5,
      };
      sorted.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));
    }
    opts.onReorder(sorted.map((j) => j.id));
  });

  const clearBtn = el<"button">("button.btn.btn-ghost", { type: "button", title: "Clear completed, cancelled, and errored downloads" }, [
    el<"span">("span", { html: icon("trash", 15) }),
    el<"span">("span", { text: "Clear finished" }),
  ]);
  clearBtn.disabled = true;

  const clearQueueBtn = el<"button">("button.btn.btn-ghost.clear-queue-btn", {
    type: "button",
    title: "Clear all downloads: Stop transfers and empty the entire queue",
    "aria-label": "Clear Queue",
  }, [
    el<"span">("span", { html: icon("trash", 15) }),
    el<"span">("span", { text: "Clear Queue" }),
  ]);
  clearQueueBtn.disabled = true;

  /* Scheduler */
  let schedulerConfig = loadSchedulerConfig();
  const schedBtnText = el<"span">("span", { text: "Scheduler" });
  const schedulerBtn = el<"button">("button.btn.btn-ghost.scheduler-btn", {
    type: "button",
    title: "Download Scheduler: Start or pause transfers automatically",
    "aria-label": "Download Scheduler",
  }, [
    el<"span">("span", { html: icon("clock", 14) }),
    schedBtnText,
  ]);

  const schedBannerText = el<"span">("span.sched-text");
  const schedEditBtn = el<"button">("button", { type: "button", text: "Edit" });
  const schedTurnOffBtn = el<"button">("button", { type: "button", text: "Turn off" });
  const schedulerBanner = el<"div">("div.scheduler-banner", { hidden: true }, [
    el<"span">("span", { html: icon("clock", 14) }),
    schedBannerText,
    el<"div">("div.sched-actions", {}, [schedEditBtn, schedTurnOffBtn]),
  ]);

  /* Post-Download Action Selector */
  const postActionSelect = el<"select">("select.post-action-select", {
    title: "Action when all downloads finish",
    "aria-label": "When completed",
  }, [
    el<"option">("option", { value: "none", text: "When done: Do nothing" }),
    el<"option">("option", { value: "open_folder", text: "When done: Open folder" }),
    el<"option">("option", { value: "chime", text: "When done: Sound alert" }),
    el<"option">("option", { value: "exit", text: "When done: Exit app" }),
    el<"option">("option", { value: "sleep", text: "When done: Sleep PC" }),
    el<"option">("option", { value: "hibernate", text: "When done: Hibernate PC" }),
    el<"option">("option", { value: "shutdown", text: "When done: Shut down PC" }),
  ]);
  try {
    postActionSelect.value = getPostDownloadAction();
  } catch {}
  postActionSelect.addEventListener("change", () => {
    setPostDownloadAction(postActionSelect.value as PostDownloadAction);
    const label = postActionSelect.options[postActionSelect.selectedIndex]?.text.replace("When done: ", "");
    toast(`When completed: ${label}`, "ok");
  });

  const onExternalPostAction = (e: Event) => {
    const act = (e as CustomEvent<string>).detail;
    if (act && postActionSelect.value !== act) {
      postActionSelect.value = act;
    }
  };
  window.addEventListener("telewire:post_action_changed", onExternalPostAction);

  const toolbar = el<"div">("div.toolbar", {}, [
    el<"div">("div.toolbar-title", {}, [
      el<"div">("div.eyebrow", { text: "Transfer queue" }),
      aggEl,
    ]),
    el<"div">("div.masthead-spacer"),
    schedulerBtn,
    pauseAllBtn,
    resumeAllBtn,
    sortBtn,
    postActionSelect,
    clearBtn,
    clearQueueBtn,
  ]);

  const queue = el<"div">("div.queue", { role: "list", "aria-label": "Downloads" });

  const empty = el<"div">("div.empty", {}, [
    el<"span">("span", { html: icon("inbox", 34) }),
    el<"h3">("h3", { text: "Nothing in the queue" }),
    el<"p">("p", {
      text: "Files you pick from a channel manifest land here and start transferring straight away.",
    }),
  ]);

  const root = el<"div">("div.main");
  root.append(toolbar, schedulerBanner, empty);
  let showingEmpty = true;

  const onClear = (): void => opts.onClearFinished();
  clearBtn.addEventListener("click", onClear);

  const onClearQueue = (): void => {
    if (confirm("Are you sure you want to clear the whole queue? All active and paused downloads will be stopped and removed.")) {
      opts.onClearQueue();
    }
  };
  clearQueueBtn.addEventListener("click", onClearQueue);
  const onPauseAll = (): void => opts.onPauseAll();
  pauseAllBtn.addEventListener("click", onPauseAll);
  const onResumeAll = (): void => opts.onResumeAll();
  resumeAllBtn.addEventListener("click", onResumeAll);

  const openSched = () => {
    openSchedulerModal(schedulerConfig, (next) => {
      schedulerConfig = next;
      syncSchedulerUI();
      if (next.enabled) {
        const timeDesc = next.startMode === "time" ? `at ${next.startTime}` : `in ${next.delayMinutes}m`;
        toast(`⏰ Scheduler enabled (${timeDesc}) — runs in background tray`, "ok");
      }
    });
  };
  schedulerBtn.addEventListener("click", openSched);
  schedEditBtn.addEventListener("click", openSched);

  schedTurnOffBtn.addEventListener("click", () => {
    schedulerConfig.enabled = false;
    schedulerConfig.targetStartMs = null;
    schedulerConfig.targetStopMs = null;
    schedulerConfig.startTriggered = false;
    schedulerConfig.stopTriggered = false;
    saveSchedulerConfig(schedulerConfig);
    syncSchedulerUI();
    toast("Scheduler turned off", "ok");
  });

  function syncSchedulerUI(): void {
    if (!schedulerConfig.enabled) {
      schedulerBtn.dataset.active = "false";
      schedBtnText.textContent = "Scheduler";
      schedulerBanner.hidden = true;
      return;
    }

    schedulerBtn.dataset.active = "true";
    const now = Date.now();

    if (schedulerConfig.targetStartMs) {
      const diff = schedulerConfig.targetStartMs - now;
      if (diff > 0) {
        const delta = formatDelta(diff);
        schedBtnText.textContent = `Starts in ${delta}`;
        schedBannerText.textContent = `Scheduled to start in ${delta} (${schedulerConfig.startTime || ""})${
          schedulerConfig.stopEnabled ? ` · Stop at ${schedulerConfig.stopTime}` : ""
        }`;
        schedulerBanner.hidden = false;
      } else if (!schedulerConfig.startTriggered) {
        schedulerConfig.startTriggered = true;
        saveSchedulerConfig(schedulerConfig);
        schedBtnText.textContent = "Scheduler active";
        opts.onResumeAll();
        toast("⏰ Scheduler: Starting transfers now", "ok");
      }
    }

    if (schedulerConfig.stopEnabled && schedulerConfig.targetStopMs) {
      const stopDiff = schedulerConfig.targetStopMs - now;
      if (stopDiff > 0) {
        if (
          schedulerConfig.startTriggered ||
          !schedulerConfig.targetStartMs ||
          schedulerConfig.targetStartMs <= now
        ) {
          const delta = formatDelta(stopDiff);
          schedBtnText.textContent = `Stops in ${delta}`;
          schedBannerText.textContent = `Active · Scheduled to pause in ${delta} (${schedulerConfig.stopTime})`;
          schedulerBanner.hidden = false;
        }
      } else if (!schedulerConfig.stopTriggered) {
        schedulerConfig.stopTriggered = true;
        schedulerConfig.enabled = false;
        saveSchedulerConfig(schedulerConfig);
        schedulerBtn.dataset.active = "false";
        schedBtnText.textContent = "Scheduler";
        schedulerBanner.hidden = true;
        opts.onPauseAll();
        toast("⏰ Scheduler: Pausing transfers as scheduled", "ok");
      }
    }
  }

  const schedTimer = setInterval(() => {
    if (dead) return;
    syncSchedulerUI();
  }, 1000);
  syncSchedulerUI();

  function syncAggregate(): void {
    const text = `${activeCount} active · ${speed(totalBps)}`;
    if (aggEl.textContent !== text) aggEl.textContent = text;
  }

  /* ---------- row construction ------------------------------------------- */

  function iconBtn(
    glyph: IconName,
    label: string,
    danger: boolean,
    onClick: () => void
  ): HTMLElement {
    const b = el<"button">(`button.btn-icon${danger ? ".btn-danger" : ""}`, {
      type: "button",
      // Icon-only controls carry both: aria-label names it, title explains it
      // to a mouse user.
      "aria-label": label,
      title: label,
      html: icon(glyph, 15),
    });
    b.addEventListener("click", () => {
      // Disarm instantly. The backend acknowledges fast now, but a queue
      // control must never be double-clickable — a second pause/cancel racing
      // the first is how downloads get restarted by accident. The state
      // transition rebuilds the whole action set, which re-enables things;
      // the timeout is only a safety net for a transition that never comes.
      if (b.disabled) return;
      b.disabled = true;
      setTimeout(() => {
        b.disabled = false;
      }, 4000);
      onClick();
    });
    return b;
  }

  function makeRow(job: Job): JobRow {
    const iconEl = el<"div">("div.job-icon");
    const nameEl = el<"div">("div.job-name");
    const channelEl = el<"span">("span.job-channel");
    const statusPill = el<"span">("span.job-status-pill");
    const header = el<"div">("div.job-header", {}, [nameEl, channelEl, statusPill]);
    const fill = el<"div">("div.bar-fill");
    const bar = el<"div">("div.bar", { role: "presentation" }, [fill]);
    const sizes = el<"span">("span");
    const spd = el<"b">("b");
    const eta = el<"span">("span");
    const conns = el<"span">("span");
    const stats = el<"div">("div.job-stats", {}, [
      sizes,
      el<"span">("span.sep", { text: "·" }),
      spd,
      el<"span">("span.sep", { text: "·" }),
      eta,
      el<"span">("span.sep", { text: "·" }),
      conns,
    ]);
    const workersEl = el<"div">("div.workers", { "aria-hidden": "true" });
    const errEl = el<"div">("div.job-err.selectable", { role: "alert" });
    const body = el<"div">("div.job-body", {}, [header, bar, stats]);
    const actions = el<"div">("div.job-actions");
    const node = el<"div">("div.job", { role: "listitem", "data-id": job.id }, [
      iconEl,
      body,
      actions,
    ]);

    return {
      node,
      iconEl,
      nameEl,
      channelEl,
      statusPill,
      fill,
      sizes,
      spd,
      eta,
      conns,
      workersEl,
      workerFills: [],
      errEl,
      body,
      actions,
      size: job.size,
      state: null,
      kind: null,
      name: "",
      channel: "",
      errText: "",
      vFill: "",
      vSizes: "",
      vSpd: "",
      vEta: "",
      vConns: "",
      vPhase: "",
      vWorkers: [],
    };
  }

  /** Buttons depend only on state, so this runs on transitions, never on the
   *  progress tick. */
  function buildActions(row: JobRow, job: Job): void {
    const kids: HTMLElement[] = [];
    switch (job.state) {
      case "running":
        kids.push(iconBtn("arrowUp", "Move up in queue", false, () => opts.onMove(job.id, "up")));
        kids.push(iconBtn("arrowDown", "Move down in queue", false, () => opts.onMove(job.id, "down")));
        kids.push(iconBtn("pause", "Pause download", false, () => opts.onPause(job.id)));
        kids.push(iconBtn("x", "Cancel download", true, () => opts.onCancel(job.id)));
        break;
      case "paused":
        kids.push(iconBtn("arrowUp", "Move up in queue", false, () => opts.onMove(job.id, "up")));
        kids.push(iconBtn("arrowDown", "Move down in queue", false, () => opts.onMove(job.id, "down")));
        kids.push(iconBtn("play", "Resume download", false, () => opts.onResume(job.id)));
        kids.push(iconBtn("x", "Cancel download", true, () => opts.onCancel(job.id)));
        break;
      case "queued":
        // A queued job waits for an explicit start. Before this it could only
        // be started in bulk with "Resume all", which is not a discoverable
        // trigger for the file you just added.
        kids.push(iconBtn("play", "Start download", false, () => opts.onResume(job.id)));
        kids.push(iconBtn("arrowUp", "Move up in queue", false, () => opts.onMove(job.id, "up")));
        kids.push(iconBtn("arrowDown", "Move down in queue", false, () => opts.onMove(job.id, "down")));
        kids.push(iconBtn("x", "Cancel download", true, () => opts.onCancel(job.id)));
        break;
      case "error":
        kids.push(iconBtn("refresh", "Retry download", false, () => opts.onRetry(job.id)));
        kids.push(iconBtn("x", "Cancel download", true, () => opts.onCancel(job.id)));
        break;
      case "cancelled":
        kids.push(iconBtn("refresh", "Retry download", false, () => opts.onRetry(job.id)));
        break;
      case "done":
        kids.push(
          iconBtn("folder", "Reveal in folder", false, () => opts.onReveal(job.dest_path))
        );
        break;
    }
    row.actions.replaceChildren(...kids);
  }

  /* ---------- shared write path ------------------------------------------ */

  /** The only function allowed to touch progress cells, from either path. */
  function paintProgress(
    row: JobRow,
    done: number,
    bps: number,
    etaS: number | null,
    workers: number,
    workerFill: number[]
  ): void {
    // Opening connections, resolving the file location and (for a file on
    // another data center) copying the authorization all happen before the
    // first byte lands. On a big file that is several seconds of a bar sitting
    // at 0 B/s, which reads as "stuck". Flag the phase so the row can say
    // "Connecting…" and run an indeterminate bar instead of a dead one.
    const phase =
      row.state === "running" && done === 0 && bps === 0 ? "connecting" : "";
    if (row.vPhase !== phase) {
      row.vPhase = phase;
      if (phase) row.node.dataset.phase = phase;
      else delete row.node.dataset.phase;
    }

    const w = `${(percent(done, row.size) * 100).toFixed(2)}%`;
    if (row.vFill !== w) {
      row.vFill = w;
      row.fill.style.width = w;
    }
    const sizes = `${bytes(done)} / ${bytes(row.size)}`;
    if (row.vSizes !== sizes) {
      row.vSizes = sizes;
      row.sizes.textContent = sizes;
    }
    const s = phase === "connecting" ? "Connecting…" : speed(bps);
    if (row.vSpd !== s) {
      row.vSpd = s;
      row.spd.textContent = s;
    }
    const e = `ETA ${duration(etaS)}`;
    if (row.vEta !== e) {
      row.vEta = e;
      row.eta.textContent = e;
    }
    const c = `${workers} ${workers === 1 ? "connection" : "connections"}`;
    if (row.vConns !== c) {
      row.vConns = c;
      row.conns.textContent = c;
    }
    syncWorkers(row, workerFill);
  }

  /** The strip is rebuilt only when the worker COUNT changes — the adaptive
   *  controller moves it rarely, while the fills move every tick. */
  function syncWorkers(row: JobRow, fills: number[]): void {
    if (fills.length !== row.workerFills.length) {
      row.workerFills = fills.map(() => el<"i">("i"));
      row.workersEl.replaceChildren(
        ...row.workerFills.map((f) => el<"div">("div.worker", {}, [f]))
      );
      row.vWorkers = new Array<string>(fills.length).fill("");
      const attached = row.workersEl.parentNode !== null;
      if (fills.length && !attached) row.body.insertBefore(row.workersEl, row.body.children[2] ?? null);
      else if (!fills.length && attached) row.workersEl.remove();
    }
    for (let i = 0; i < fills.length; i++) {
      const raw = fills[i] ?? 0;
      const w = `${(Math.max(0, Math.min(1, raw)) * 100).toFixed(1)}%`;
      if (row.vWorkers[i] === w) continue;
      row.vWorkers[i] = w;
      const node = row.workerFills[i];
      if (node) node.style.width = w;
    }
  }

  function flagJustDone(row: JobRow, id: string): void {
    // The landing pulse is a completion cue, not decoration — suppress it
    // entirely rather than shortening it when motion is reduced.
    if (reducedMotion()) return;
    const prev = doneTimers.get(id);
    if (prev !== undefined) clearTimeout(prev);
    row.node.dataset.justDone = "true";
    doneTimers.set(
      id,
      setTimeout(() => {
        doneTimers.delete(id);
        delete row.node.dataset.justDone;
      }, JUST_DONE_MS) as unknown as number
    );
  }

  function updateRow(row: JobRow, job: Job): void {
    row.size = job.size;

    if (row.state !== job.state) {
      // A job that is already done the first time we see it (app restart,
      // list_jobs replay) has not just landed — don't pulse it.
      const firstSight = row.state === null;
      row.state = job.state;
      row.node.dataset.state = job.state;
      buildActions(row, job);
      if (job.state === "done" && !firstSight) flagJustDone(row, job.id);
    }

    const kind = kindOf(job.name);
    if (row.kind !== kind) {
      row.kind = kind;
      row.iconEl.innerHTML = kindIcon(kind, 16); // ours, never remote content
    }
    if (row.name !== job.name) {
      row.name = job.name;
      row.nameEl.textContent = job.name;
      row.nameEl.title = job.name;
    }
    if (row.channel !== (job.channel_title ?? "")) {
      row.channel = job.channel_title ?? "";
      row.channelEl.textContent = row.channel;
      row.channelEl.title = row.channel;
    }
    const stateLabel = job.state.toUpperCase();
    if (row.statusPill.textContent !== stateLabel) {
      row.statusPill.textContent = stateLabel;
      row.statusPill.dataset.state = job.state;
    }

    const err = job.state === "error" ? (job.error ?? "Transfer failed") : "";
    if (row.errText !== err) {
      row.errText = err;
      if (err) {
        row.errEl.textContent = err;
        if (row.errEl.parentNode === null) row.body.append(row.errEl);
      } else row.errEl.remove();
    }

    paintProgress(row, job.done, job.speed_bps, job.eta_s, job.workers, job.worker_fill);
  }

  /* ---------- api -------------------------------------------------------- */

  function showList(list: boolean): void {
    if (showingEmpty === !list) return;
    showingEmpty = !list;
    (list ? empty : queue).remove();
    root.append(list ? queue : empty);
  }

  return {
    el: root,

    render(jobs: Job[]): void {
      if (dead) return;
      currentJobs = jobs;
      const seen = new Set<string>();
      let running = 0;
      let bps = 0;
      let finished = 0;
      let activeOrQueued = 0;
      let startable = 0;

      // Walk the desired order and slide each node into place. Nodes already
      // in position are not touched, so focus and scroll survive.
      let prev: Node | null = null;
      for (const job of jobs) {
        seen.add(job.id);
        if (job.state === "running") {
          running++;
          bps += job.speed_bps;
        }
        if (job.state === "running" || job.state === "queued") {
          activeOrQueued++;
        }
        if (
          job.state === "queued" ||
          job.state === "paused" ||
          job.state === "error" ||
          job.state === "cancelled"
        ) {
          startable++;
        }
        if (isFinished(job.state)) finished++;

        let row = rows.get(job.id);
        if (!row) {
          row = makeRow(job);
          rows.set(job.id, row);
        }
        updateRow(row, job);

        const expected: ChildNode | null = prev ? prev.nextSibling : queue.firstChild;
        if (expected !== row.node) queue.insertBefore(row.node, expected);
        prev = row.node;
      }

      for (const [id, row] of rows) {
        if (seen.has(id)) continue;
        rows.delete(id);
        const t = doneTimers.get(id);
        if (t !== undefined) {
          clearTimeout(t);
          doneTimers.delete(id);
        }
        row.node.remove();
      }

      activeCount = running;
      totalBps = bps;
      syncAggregate();
      pauseAllBtn.disabled = activeOrQueued === 0;
      resumeAllBtn.disabled = startable === 0;
      clearBtn.disabled = finished === 0;
      clearQueueBtn.disabled = jobs.length === 0;
      showList(jobs.length > 0);
    },

    applyProgress(batch: ProgressBatch): void {
      if (dead) return;
      for (const p of batch.jobs) {
        const row = rows.get(p.id);
        if (!row) continue; // job arrived before its render(); the next one fixes it
        paintProgress(row, p.done, p.speed_bps, p.eta_s, p.workers, p.worker_fill);
      }
      activeCount = batch.jobs.length;
      totalBps = batch.total_bps;
      syncAggregate();
    },

    destroy(): void {
      dead = true;
      clearInterval(schedTimer);
      window.removeEventListener("telewire:post_action_changed", onExternalPostAction);
      clearBtn.removeEventListener("click", onClear);
      clearQueueBtn.removeEventListener("click", onClearQueue);
      pauseAllBtn.removeEventListener("click", onPauseAll);
      resumeAllBtn.removeEventListener("click", onResumeAll);
      for (const t of doneTimers.values()) clearTimeout(t);
      doneTimers.clear();
      // Action listeners live on nodes we drop wholesale, so they go with them.
      queue.replaceChildren();
      rows.clear();
    },
  };
}
