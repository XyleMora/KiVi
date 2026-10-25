// 16 px icons for the desktop header and menus. The repository and pull
// request glyphs follow GitHub's Octicons (MIT licence) so the switch reads the
// same as github.com's header; the menu icons are simple strokes.

const svg = (body, extra = "") => `<svg class="icon16" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"${extra}>${body}</svg>`;
const stroke = (body) => svg(body, ' fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"');

/** Gear outline with eight teeth, centred in the 16 px box. */
function gearPath() {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 2 * Math.PI;
    for (const [da, r] of [[-0.2, 5.2], [-0.13, 6.6], [0.13, 6.6], [0.2, 5.2]]) pts.push([8 + r * Math.cos(a + da), 8 + r * Math.sin(a + da)]);
  }
  return "M" + pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L") + "Z";
}

export const ICONS = {
  repo: svg(`<path fill="currentColor" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>`),
  pullRequest: svg(`<path fill="currentColor" d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>`),
  person: stroke(`<circle cx="8" cy="5" r="3"/><path d="M2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/>`),
  gear: stroke(`<path d="${gearPath()}"/><circle cx="8" cy="8" r="2.2"/>`),
  key: stroke(`<circle cx="5" cy="11" r="3"/><path d="M7.2 8.8 14 2M11.5 4.5l1.8 1.8M9.8 6.2l1.4 1.4"/>`),
  signIn: stroke(`<path d="M10 2.5h2.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10M5.5 5l3 3-3 3M8.5 8H1.5"/>`),
  signOut: stroke(`<path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 5l3 3-3 3M13.5 8H6"/>`),
  folder: stroke(`<path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z"/>`),
  chevron: stroke(`<path d="M4.5 6.5 8 10l3.5-3.5"/>`),
};
