/**
 * Inline SVG icons (Lucide geometry, redrawn — MIT). Never emoji: emoji render
 * differently per OS, can't inherit `currentColor`, and read as decoration in
 * an instrument panel.
 *
 * All icons are 24x24 with a 2px stroke and inherit `currentColor`, so a single
 * `color:` on the parent styles them.
 */

const wrap = (paths: string, size: number): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const P: Record<string, string> = {
  // Brand: a wire the bytes drop down through — a "T" that is also a download.
  mark: '<path d="M3 5h18"/><path d="M12 5v14"/><path d="m7 14 5 5 5-5"/>',
  // Brand (retired): a telegraph key / signal tap.
  wire: '<path d="M2 12h5l3-7 4 14 3-7h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
  download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m4 12 5.5 5.5L20 7"/>',
  alert: '<path d="M12 8v5"/><circle cx="12" cy="16.5" r=".7" fill="currentColor"/><path d="M10.3 3.9 2.5 17.4A2 2 0 0 0 4.2 20.4h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".7" fill="currentColor"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M16 4v16M3 12h18M3 8h5M3 16h5M16 8h5M16 16h5"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m4 17 5-4.5 4 3.5 3-2.5 4 4"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  logout: '<path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 4v7h-7"/>',
  inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5.5 5h13l2.5 7v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6z"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.8 12.2 8.2-8.2"/><path d="m16 7 2.5 2.5"/><path d="M19 4l2 2"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  arrowUpToLine: '<path d="m18 15-6-6-6 6"/><path d="M4 4h16"/>',
  arrowDownToLine: '<path d="m6 9 6 6 6-6"/><path d="M4 20h16"/>',
  arrowUpDown: '<path d="m21 16-4 4-4-4"/><path d="M17 20V4"/><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/>',
  messageSquare: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 6 12 12 16 14"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
};

export type IconName = keyof typeof P;

export function icon(name: keyof typeof P, size = 16): string {
  return wrap(P[name] ?? P.file, size);
}

/** Icon for a media row, chosen from the item's kind. */
export function kindIcon(kind: string, size = 14): string {
  switch (kind) {
    case "video":
      return icon("film", size);
    case "audio":
      return icon("music", size);
    case "photo":
      return icon("image", size);
    default:
      return icon("file", size);
  }
}
