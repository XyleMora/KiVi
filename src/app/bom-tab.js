// Bill of materials built from the schematic (falls back to the board).

import { $, escapeHtml, refCompare } from "./ui.js";
import { libSymbolFor } from "../sch/model.js";

const EXTRA_FIELDS = ["MPN", "Manufacturer", "Manufacturer_Part_Number", "MFR", "LCSC", "Digikey", "Mouser", "Description"];

export class BomTab {
  constructor(app) {
    this.app = app;
    this.sort = { key: "refs", dir: 1 };
    $("#bom-filter").addEventListener("input", () => this.renderTable());
    $("#bom-group").addEventListener("change", () => this.renderTable());
    $("#bom-csv").addEventListener("click", () => this.download());
  }

  load(project) {
    this.project = project;
    this.parts = project.pages.length ? fromSchematic(project) : fromBoard(project.pcb);
    const present = new Set();
    for (const p of this.parts) for (const k of Object.keys(p.fields)) present.add(k);
    this.extra = EXTRA_FIELDS.filter((f) => present.has(f));
    this.renderTable();
  }

  rows() {
    const q = $("#bom-filter").value.trim().toLowerCase();
    let parts = this.parts;
    if (q) parts = parts.filter((p) => [p.ref, p.value, p.footprint, ...Object.values(p.fields)].some((v) => String(v).toLowerCase().includes(q)));
    let rows;
    if ($("#bom-group").checked) {
      const groups = new Map();
      for (const p of parts) {
        const key = [p.value, p.footprint, p.dnp, ...this.extra.map((f) => p.fields[f] ?? "")].join("\u0000");
        if (!groups.has(key)) groups.set(key, { ...p, refs: [] });
        groups.get(key).refs.push(p.ref);
      }
      rows = [...groups.values()].map((g) => ({ ...g, refs: g.refs.sort(refCompare) }));
    } else rows = parts.map((p) => ({ ...p, refs: [p.ref] }));
    const { key, dir } = this.sort;
    const val = (r) => (key === "refs" ? r.refs[0] : key === "qty" ? r.refs.length : key in r ? r[key] : r.fields[key] ?? "");
    rows.sort((a, b) => (key === "qty" ? val(a) - val(b) : refCompare(val(a), val(b))) * dir);
    return rows;
  }

  renderTable() {
    if (!this.parts) return;
    const rows = this.rows();
    const cols = [["refs", "References"], ["qty", "Qty"], ["value", "Value"], ["footprint", "Footprint"], ...this.extra.map((f) => [f, f])];
    const arrow = (k) => (this.sort.key === k ? (this.sort.dir > 0 ? " ▲" : " ▼") : "");
    const total = rows.reduce((n, r) => n + r.refs.length, 0);
    $("#bom-table").innerHTML =
      `<thead><tr>${cols.map(([k, l]) => `<th data-key="${k}">${escapeHtml(l)}${arrow(k)}</th>`).join("")}</tr></thead>` +
      `<tbody>${rows
        .map(
          (r) =>
            `<tr class="${r.dnp ? "dnp" : ""}"><td class="refs">${r.refs.map((x) => `<a class="ref" data-ref="${escapeHtml(x)}">${escapeHtml(x)}</a>`).join(", ")}${r.dnp ? ' <span class="tag warn">DNP</span>' : ""}</td>` +
            `<td class="qty">${r.refs.length}</td><td>${escapeHtml(r.value)}</td><td class="mono" style="font-size:12px">${escapeHtml(r.footprint)}</td>` +
            this.extra.map((f) => `<td>${escapeHtml(r.fields[f] ?? "")}</td>`).join("") +
            `</tr>`,
        )
        .join("")}</tbody>` +
      `<tfoot><tr><td class="muted">${rows.length} lines</td><td class="qty">${total}</td><td colspan="${cols.length - 2}"></td></tr></tfoot>`;
    for (const th of document.querySelectorAll("#bom-table th")) {
      th.addEventListener("click", () => {
        this.sort = { key: th.dataset.key, dir: this.sort.key === th.dataset.key ? -this.sort.dir : 1 };
        this.renderTable();
      });
    }
    for (const a of document.querySelectorAll("#bom-table a.ref")) {
      a.addEventListener("click", () => this.app.crossProbe(a.dataset.ref, this.project.pages.length ? "sch" : "pcb"));
    }
  }

  download() {
    const rows = this.rows();
    const head = ["References", "Qty", "Value", "Footprint", ...this.extra, "DNP"];
    const csv = [head, ...rows.map((r) => [r.refs.join(" "), r.refs.length, r.value, r.footprint, ...this.extra.map((f) => r.fields[f] ?? ""), r.dnp ? "DNP" : ""])]
      .map((line) => line.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${this.project.name}-bom.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

/** One entry per physical part (multi-unit symbols collapse to one reference). */
function fromSchematic(project) {
  const parts = new Map();
  for (const page of project.pages) {
    const sch = page.sch;
    for (const s of sch.symbols) {
      const lib = libSymbolFor(sch, s);
      if (lib?.power || !s.inBom) continue;
      const inst = s.instances.find((i) => i.path === page.path) ?? s.instances.find((i) => i.path.replace(/^\/[^/]+/, "") === page.path.replace(/^\/[^/]+/, ""));
      let ref = inst?.reference || s.properties.find((p) => p.name === "Reference")?.value || "?";
      if (project.legacyInstances) ref = project.legacyInstances.get(`${page.legacyPath}/${s.uuid}`)?.reference ?? ref;
      if (!ref || ref.startsWith("#")) continue;
      if (parts.has(ref)) continue;
      const fields = {};
      for (const p of s.properties) if (!["Reference", "Value", "Footprint", "Datasheet"].includes(p.name) && p.value && p.value !== "~") fields[p.name] = p.value;
      parts.set(ref, {
        ref,
        value: s.properties.find((p) => p.name === "Value")?.value ?? "",
        footprint: (s.properties.find((p) => p.name === "Footprint")?.value ?? "").replace(/^[^:]*:/, ""),
        dnp: s.dnp,
        fields,
      });
    }
  }
  return [...parts.values()];
}

function fromBoard(pcb) {
  if (!pcb) return [];
  return pcb.footprints
    .filter((f) => f.reference && !f.attrs.includes("exclude_from_bom") && !f.attrs.includes("board_only"))
    .map((f) => ({ ref: f.reference, value: f.value, footprint: f.libId.replace(/^[^:]*:/, ""), dnp: f.dnp, fields: { ...f.properties } }));
}

