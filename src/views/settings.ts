/**
 * Settings modal.
 *
 * The concurrency controls are deliberately visible rather than buried: §11
 * treats respectful rate limiting as a user-facing concern, because this runs
 * on a real personal account and an over-eager worker count is what gets a
 * person flood-waited. The copy says so plainly instead of presenting the
 * numbers as free performance.
 */

import type { Settings } from "../lib/types";
import * as ipc from "../lib/ipc";
import { icon } from "../lib/icons";
import { el, modal, toast } from "../lib/ui";

export function openSettings(current: Settings, onSaved: (next: Settings) => void): void {
  const draft: Settings = { ...current };

  const rootPath = el("input.input", {
    id: "dl-root",
    type: "text",
    value: draft.download_root,
    spellcheck: "false",
  }) as HTMLInputElement;

  const browse = el(
    "button.btn",
    { type: "button" },
    [el("span", { html: icon("folder", 15) }), el("span", {}, "Browse")]
  ) as HTMLButtonElement;
  browse.addEventListener("click", async () => {
    try {
      const picked = await ipc.pickDirectory();
      if (picked) rootPath.value = picked;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  });

  const workers = el("input", {
    id: "max-workers",
    type: "range",
    min: "1",
    max: "16",
    step: "1",
    value: String(draft.max_workers),
  }) as HTMLInputElement;
  const workersOut = el("output.mono", { for: "max-workers" }, String(draft.max_workers));
  workers.addEventListener("input", () => (workersOut.textContent = workers.value));

  const jobs = el("input", {
    id: "max-jobs",
    type: "range",
    min: "1",
    max: "8",
    step: "1",
    value: String(draft.max_concurrent_jobs),
  }) as HTMLInputElement;
  const jobsOut = el("output.mono", { for: "max-jobs" }, String(draft.max_concurrent_jobs));
  jobs.addEventListener("input", () => (jobsOut.textContent = jobs.value));

  const adaptive = el("input", { type: "checkbox", checked: draft.adaptive }) as HTMLInputElement;
  const organize = el("input", { type: "checkbox", checked: draft.organize }) as HTMLInputElement;
  const organizeByType = el("input", {
    type: "checkbox",
    checked: draft.organize_by_type ?? true,
  }) as HTMLInputElement;
  const notifyOnComplete = el("input", {
    type: "checkbox",
    checked: draft.notify_on_complete ?? true,
  }) as HTMLInputElement;

  const postActionSelect = el("select.input", { id: "post-action" }, [
    el("option", { value: "none" }, "Do nothing"),
    el("option", { value: "open_folder" }, "Open download folder"),
    el("option", { value: "chime" }, "Play notification sound"),
    el("option", { value: "exit" }, "Exit application"),
    el("option", { value: "sleep" }, "Put computer to sleep"),
    el("option", { value: "hibernate" }, "Hibernate computer"),
    el("option", { value: "shutdown" }, "Shut down computer"),
  ]) as HTMLSelectElement;
  try {
    postActionSelect.value = localStorage.getItem("telewire.post_download_action") || "none";
  } catch {}

  const row = (label: string, control: HTMLElement, out: HTMLElement, hint: string) =>
    el("div.field", {}, [
      el("label", { for: control.id }, [
        el("span", {}, label),
        el("span", { style: "float:right" }, [out]),
      ]),
      control,
      el("p.field-hint", {}, hint),
    ]);

  const save = el("button.btn.btn-primary", { type: "button" }, "Save") as HTMLButtonElement;
  const cancel = el("button.btn.btn-ghost", { type: "button" }, "Cancel") as HTMLButtonElement;

  const body = el("div", {}, [
    el("div.modal-head", {}, [
      el("span", { html: icon("settings", 18) }),
      el("div.modal-title", {}, [
        el("h2", { id: "settings-title" }, "Settings"),
        el("p.field-hint", {}, "Stored locally. Nothing here is ever transmitted."),
      ]),
    ]),

    el("div.auth-form", {}, [
      el("div.field", {}, [
        el("label", { for: "dl-root" }, "Download folder"),
        el("div", { style: "display:flex; gap:8px" }, [rootPath, browse]),
        el("p.field-hint", {}, "Files land here, grouped by channel and month when organising is on."),
      ]),

      el("label.switch", {}, [
        organizeByType,
        el("span", {}, [
          el("div", {}, "Sort by media type"),
          el("div.field-hint", {}, "Automatically place files into Videos/, Audio/, Photos/, Documents/ subfolders."),
        ]),
      ]),

      el("label.switch", {}, [
        organize,
        el("span", {}, [
          el("div", {}, "Organise into channel folders"),
          el("div.field-hint", {}, "<channel>/<year>-<month>/<filename> subfolders."),
        ]),
      ]),

      el("label.switch", {}, [
        notifyOnComplete,
        el("span", {}, [
          el("div", {}, "Windows Toast notifications"),
          el("div.field-hint", {}, "Display native Windows 10/11 notification banners when downloads finish."),
        ]),
      ]),

      row(
        "Maximum connections per file",
        workers,
        workersOut,
        "More parallel range-fetches per file. Higher is faster up to a point, then Telegram starts issuing flood-waits — 8 is a sane ceiling for a personal account."
      ),

      el("label.switch", {}, [
        adaptive,
        el("span", {}, [
          el("div", {}, "Adaptive concurrency"),
          el("div.field-hint", {}, "Tune the connection count from measured throughput instead of pinning it to the maximum. Leave this on unless you are benchmarking."),
        ]),
      ]),

      row(
        "Files downloading at once",
        jobs,
        jobsOut,
        "Separate from connections-per-file. Three simultaneous files at eight connections each is already twenty-four open range-fetches."
      ),

      el("div.field", {}, [
        el("label", { for: "post-action" }, "When all downloads finish"),
        postActionSelect,
        el("p.field-hint", {}, "Action to perform automatically once the transfer queue finishes."),
      ]),
    ]),

    el("div.modal-foot", {}, [cancel, save]),
  ]);

  const close = modal(body, { labelledBy: "settings-title" });
  cancel.addEventListener("click", close);

  save.addEventListener("click", async () => {
    try {
      localStorage.setItem("telewire.post_download_action", postActionSelect.value);
      window.dispatchEvent(
        new CustomEvent("telewire:post_action_changed", { detail: postActionSelect.value })
      );
    } catch {}
    const next: Settings = {
      download_root: rootPath.value.trim() || current.download_root,
      max_workers: Number(workers.value),
      max_concurrent_jobs: Number(jobs.value),
      adaptive: adaptive.checked,
      organize: organize.checked,
      organize_by_type: organizeByType.checked,
      notify_on_complete: notifyOnComplete.checked,
    };
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const saved = await ipc.setSettings(next);
      onSaved(saved);
      close();
      toast("Settings saved.", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
      save.disabled = false;
      save.textContent = "Save";
    }
  });
}
