import * as ipc from "./ipc";
import { el } from "./ui";

export function createFooterCredits(): HTMLElement {
  const p = el("p.footer-credits", {}, [
    "Made with ",
    el("span.beating-heart", { html: "&#10084;&#65039;" }),
    " by ",
    el(
      "a.credit-link",
      {
        href: "https://linktr.ee/sasmithakr",
        target: "_blank",
        rel: "noopener noreferrer",
      },
      "Sasmitha K Randunu"
    ),
  ]);

  const link = p.querySelector<HTMLAnchorElement>("a.credit-link");
  if (link) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const href = link.getAttribute("href") || "https://linktr.ee/sasmithakr";
      ipc.openUrl(href).catch(() => {
        window.open(href, "_blank", "noopener,noreferrer");
      });
    });
  }

  return p;
}
