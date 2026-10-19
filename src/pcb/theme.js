// PCB colours. "kicad" follows KiCad's default pcbnew theme.

const INNER = ["#7FC87F", "#CE7D2C", "#4FCBCB", "#DB628B", "#A7A5C6", "#28CCD9", "#E8B2A7", "#F2EDA1", "#8D4F92", "#5A8F6E", "#C2B850", "#5F89BD", "#B2617C", "#8FA6A0", "#C08A5B"];

const KICAD = {
  "F.Cu": "#C83434",
  "B.Cu": "#4D7FC4",
  "F.Adhes": "#841F84",
  "B.Adhes": "#000084",
  "F.Paste": "#B4A09A",
  "B.Paste": "#00C2C2",
  "F.SilkS": "#F2EDA1",
  "B.SilkS": "#E8B2A7",
  "F.Mask": "#D864FF",
  "B.Mask": "#02FFEE",
  "Dwgs.User": "#C2C2C2",
  "Cmts.User": "#5965FF",
  "Eco1.User": "#B4DBD2",
  "Eco2.User": "#D8C852",
  "Edge.Cuts": "#D0D2CD",
  Margin: "#FF26E2",
  "F.CrtYd": "#FF26E2",
  "B.CrtYd": "#26E9FF",
  "F.Fab": "#AFAFAF",
  "B.Fab": "#585D84",
};

export const PCB_THEMES = {
  kicad: {
    name: "KiCad default",
    background: "#001023",
    via: "#ECECEC",
    viaBlind: "#BB9775",
    viaMicro: "#0082C2",
    hole: "#1A1E24",
    holeWall: "#C2C200",
    npHole: "#2C3138",
    ratsnest: "#A2D5D5",
    selection: "#FFFFFF",
    highlight: "#FFFFFF",
    layer(name) {
      if (KICAD[name]) return KICAD[name];
      const m = /^In(\d+)\.Cu$/.exec(name);
      if (m) return INNER[(Number(m[1]) - 1) % INNER.length];
      if (name.startsWith("User.")) return "#C2C2C2";
      return "#9C9C9C";
    },
  },
};

/** Layer opacity: masks are translucent, copper slightly so to show overlap. */
export function layerOpacity(name) {
  if (name.endsWith(".Mask")) return 0.4;
  if (name.endsWith(".Paste")) return 0.7;
  if (name.endsWith(".Cu")) return 0.85;
  if (name.endsWith(".Fab") || name.endsWith(".CrtYd")) return 0.85;
  return 1;
}
