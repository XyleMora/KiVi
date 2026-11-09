// Ctrl + mouse wheel resizes the project gallery's cards (thumbnails and text
// together), like a file manager's icon size. CSS `zoom` on the grid scales
// the column width too, so bigger cards also mean fewer per row. Ctrl+0 resets.
// The size is a per-machine convenience, kept in localStorage.

const KEY = "kivi.cardZoom";
const MIN = 0.5;
const MAX = 2.5;

function load() {
  try {
    const z = Number(localStorage.getItem(KEY));
    return z >= MIN && z <= MAX ? z : 1;
  } catch {
    return 1;
  }
}

function store(z) {
  try {
    localStorage.setItem(KEY, String(z));
  } catch {
    /* storage unavailable: the size just isn't remembered */
  }
}

/**
 * Let Ctrl + wheel (and Ctrl+0) inside `area` zoom the card `grid`.
 * @param {HTMLElement} area the projects view (where the wheel is listened for)
 * @param {HTMLElement} grid the card grid that gets scaled
 */
export function initCardZoom(area, grid) {
  let zoom = load();
  const apply = () => (grid.style.zoom = zoom === 1 ? "" : String(zoom));
  apply();

  // Not passive: preventDefault stops the webview's own page zoom, where it has one.
  area.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // Line-mode wheels report lines, pixel-mode ~100 px per notch; touchpads send
      // many small deltas, so scale smoothly rather than one step per event.
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      zoom = Math.min(MAX, Math.max(MIN, zoom * Math.exp(-dy * 0.0015)));
      if (Math.abs(zoom - 1) < 0.04) zoom = 1; // snap back to the default size
      apply();
      store(zoom);
    },
    { passive: false },
  );

  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.key !== "0" || area.hidden) return;
    e.preventDefault();
    zoom = 1;
    apply();
    store(zoom);
  });
}
