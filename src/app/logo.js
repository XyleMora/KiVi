// The header logo: assets/kivi-logo.svg drawn in the header's colours. The file
// is a kiwi in the brand orange (--accent) with white details; an <img> can't
// be recoloured, so the SVG is inlined with the orange parts in currentColor
// (like the "KiVi" letters, so they follow --accent) and the white ones in the
// header background (--surface), so the details read as cut-outs.

const LOGO_ORANGE = "#f0a63b";
const LOGO_LIGHT = ["#fff", "#ffffff"];

async function inlineLogo(img) {
  const text = await (await fetch(img.src)).text();
  const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
  if (svg.nodeName !== "svg") return;
  svg.querySelector("title")?.remove();
  for (const el of svg.querySelectorAll("*")) {
    for (const prop of ["fill", "stroke"]) {
      const v = el.getAttribute(prop)?.toLowerCase();
      if (v === LOGO_ORANGE) el.style[prop] = "currentColor";
      else if (LOGO_LIGHT.includes(v)) el.style[prop] = "var(--surface)";
    }
  }
  svg.setAttribute("class", img.getAttribute("class"));
  svg.setAttribute("width", img.getAttribute("width"));
  svg.setAttribute("height", img.getAttribute("height"));
  svg.setAttribute("aria-hidden", "true");
  img.replaceWith(document.importNode(svg, true));
}

for (const img of document.querySelectorAll("img.brand-mark")) {
  inlineLogo(img).catch(() => img.classList.add("plain")); // can't inline: show the file as it is
}
