import type { ChannelInfo } from "../lib/types";
import * as ipc from "../lib/ipc";
import { icon, kindIcon } from "../lib/icons";
import { el, modal, toast } from "../lib/ui";
import { bytes } from "../lib/format";

export function openGrabLinkModal(opts: {
  onEnqueue: (channelId: number, messageIds: number[], startNow?: boolean) => void;
  onSelectChannel: (channel: ChannelInfo) => void;
}): void {
  const input = el("input.input", {
    type: "text",
    placeholder: "Paste link: e.g. https://t.me/durov/123 or t.me/c/12345/678",
    autocomplete: "off",
    spellcheck: "false",
    style: "flex:1",
  }) as HTMLInputElement;

  const pasteBtn = el(
    "button.btn.btn-ghost",
    {
      type: "button",
      title: "Paste from clipboard",
      style: "padding: 0 10px;",
    },
    [el("span", { text: "Paste" })]
  ) as HTMLButtonElement;

  pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        input.value = text.trim();
        void resolveLink();
      } else {
        toast("Clipboard is empty", "info");
      }
    } catch {
      toast("Could not access clipboard", "error");
    }
  });

  // Try auto-reading clipboard on open if it looks like a t.me link
  navigator.clipboard?.readText?.().then((text) => {
    if (
      text &&
      (text.includes("t.me/") || text.includes("telegram.me/") || text.startsWith("@"))
    ) {
      input.value = text.trim();
    }
  }).catch(() => {});

  const resolveBtn = el(
    "button.btn.btn-primary",
    {
      type: "button",
      style: "min-width:80px",
    },
    "Resolve"
  ) as HTMLButtonElement;

  const statusEl = el("div.field-hint", { style: "min-height: 18px; margin-top: 4px;" }, "");
  const resultContainer = el("div.grab-result-container", {
    style: "display: flex; flex-direction: column; gap: 8px;",
  });

  const body = el("div", {}, [
    el("div.modal-head", {}, [
      el("span", { html: icon("link", 20) }),
      el("div.modal-title", {}, [
        el("h2", { id: "grab-title" }, "Telegram Link Grabber"),
        el("p.field-hint", {}, "Download files directly from any Telegram post or channel link."),
      ]),
    ]),
    el("div.auth-form", {}, [
      el("div.field", {}, [
        el("label", { for: "grab-input" }, "Post or channel URL"),
        el("div", { style: "display:flex; gap:8px" }, [input, pasteBtn, resolveBtn]),
        statusEl,
      ]),
      resultContainer,
    ]),
  ]);

  const close = modal(body, { labelledBy: "grab-title" });

  const resolveLink = async () => {
    const raw = input.value.trim();
    if (!raw) {
      statusEl.textContent = "Please enter or paste a Telegram link.";
      statusEl.style.color = "#f87171";
      return;
    }

    resolveBtn.disabled = true;
    resolveBtn.textContent = "Resolving…";
    statusEl.textContent = "Connecting to Telegram and resolving message…";
    statusEl.style.color = "";
    resultContainer.replaceChildren();

    try {
      const res = await ipc.grabTelegramLink(raw);
      statusEl.textContent = `Found channel: ${res.channel.title}${
        res.channel.username ? ` (@${res.channel.username})` : ""
      }`;
      statusEl.style.color = "var(--cyan)";

      if (res.items.length === 0) {
        // Channel resolved, but no media in post
        const browseBtn = el("button.btn.btn-primary", { type: "button" }, "Open Channel in Browser");
        browseBtn.addEventListener("click", () => {
          opts.onSelectChannel(res.channel);
          close();
        });
        resultContainer.replaceChildren(
          el("div.grab-result-card", {}, [
            el("div", { style: "font-weight: 500;" }, "No downloadable media in this specific post."),
            el(
              "div.field-hint",
              {},
              `Would you like to open ${res.channel.title} in the channel browser to see all files?`
            ),
            el("div.modal-foot", { style: "margin-top: 8px;" }, [browseBtn]),
          ])
        );
      } else {
        // Files found!
        const itemsList = el("div", {
          style: "display:flex; flex-direction:column; gap:6px; max-height:240px; overflow-y:auto;",
        });
        for (const it of res.items) {
          const thumbEl = it.thumb
            ? el("img.grab-item-thumb", { src: it.thumb, alt: "" })
            : el("div.grab-item-thumb", { html: kindIcon(it.kind, 22) });

          itemsList.append(
            el("div.grab-item-row", {}, [
              thumbEl,
              el("div", { style: "flex:1; min-width:0;" }, [
                el(
                  "div",
                  {
                    style:
                      "font-weight: 600; font-size: 13px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;",
                    title: it.name,
                  },
                  it.name
                ),
                el("div.field-hint", { style: "font-size: 11px;" }, [
                  el("span.mono", {}, bytes(it.size)),
                  it.caption ? el("span", { style: "margin-left: 8px;" }, `· ${it.caption}`) : null,
                ].filter(Boolean) as HTMLElement[]),
              ]),
            ])
          );
        }

        const msgIds = res.items.map((i) => i.message_id);

        const dlNowBtn = el("button.btn.btn-primary", { type: "button" }, [
          el("span", { html: icon("download", 14) }),
          el("span", {}, `Download Now (${res.items.length})`),
        ]);
        dlNowBtn.addEventListener("click", () => {
          opts.onEnqueue(res.channel.id, msgIds, true);
          toast(`Downloading ${res.items.length} file(s)...`, "ok");
          close();
        });

        const queueBtn = el("button.btn.btn-ghost", { type: "button" }, [
          el("span", { html: icon("clock", 14) }),
          el("span", {}, "Add to Queue"),
        ]);
        queueBtn.addEventListener("click", () => {
          opts.onEnqueue(res.channel.id, msgIds, false);
          toast(`Added ${res.items.length} file(s) to queue`, "ok");
          close();
        });

        const openChanBtn = el("button.btn.btn-ghost", { type: "button" }, "View Channel");
        openChanBtn.addEventListener("click", () => {
          opts.onSelectChannel(res.channel);
          close();
        });

        resultContainer.replaceChildren(
          el("div.grab-result-card", {}, [
            itemsList,
            el(
              "div.modal-foot",
              { style: "margin-top: 10px; justify-content: flex-end; gap: 8px;" },
              [openChanBtn, queueBtn, dlNowBtn]
            ),
          ])
        );
      }
    } catch (e) {
      statusEl.textContent = e instanceof Error ? e.message : String(e);
      statusEl.style.color = "#f87171";
    } finally {
      resolveBtn.disabled = false;
      resolveBtn.textContent = "Resolve";
    }
  };

  resolveBtn.addEventListener("click", () => void resolveLink());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void resolveLink();
    }
  });

  input.focus();
}
