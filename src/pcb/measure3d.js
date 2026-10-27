// Measuring tool for the 3D view: click two points on the board or on parts
// to read the distance (mm and mil) and Δx, Δy, Δz in board terms (Δz = height).
// On the board face, points snap to pads, vias, track ends and outline corners
// (snap.js); on a part, to the nearest corner of its model; Shift measures freely.
//
// It works through Board3D's `tool` hook, so while it's on, clicks don't
// select parts. World coordinates are board x, −board y and height above the
// bottom face.

import * as THREE from "../../vendor/three/three.module.js";
import { snapPoints } from "./snap.js";

const SNAP_PX = 10;
const MIL = 0.0254;
const COLOUR = 0xff5fd2; // --ms in style.css
const MAX_VERTICES = 300000; // larger models are only measured where clicked

export class Measure3D {
  /**
   * @param {import("./board3d.js").Board3D} view
   * @param {object} o
   * @param {HTMLElement} o.button  toggles the tool (aria-pressed)
   * @param {HTMLElement} o.chip    hint and readout over the canvas
   * @param {HTMLElement} o.label   label that follows the measured point
   */
  constructor(view, { button, chip, label }) {
    this.view = view;
    this.button = button;
    this.chip = chip;
    this.labelEl = label;
    this.active = false;
    this.faceCands = new Map();

    const mat = (o) => ({ color: COLOUR, depthTest: false, transparent: true, ...o });
    this.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial(mat()));
    this.ends = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.PointsMaterial(mat({ size: 7, sizeAttenuation: false })));
    this.snapMark = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), new THREE.PointsMaterial(mat({ size: 14, sizeAttenuation: false, opacity: 0.45 })));
    this.group = new THREE.Group();
    this.group.add(this.line, this.ends, this.snapMark);
    for (const o of this.group.children) o.renderOrder = 20;
    this.group.visible = false;
    view.scene.add(this.group);

    view.tool = this;
    this._click = () => this.toggle();
    button.addEventListener("click", this._click);
    const box = view.container;
    box.tabIndex = 0;
    this._focus = () => box.focus({ preventScroll: true });
    this._key = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "m" || e.key === "M") {
        this.toggle();
        e.preventDefault();
      } else if (e.key === "Escape" && this.active) {
        // First Escape drops the measurement, the next one leaves the tool.
        if (this.a) this.reset();
        else this.toggle(false);
      }
    };
    box.addEventListener("pointerdown", this._focus);
    box.addEventListener("keydown", this._key);
    this.reset();
  }

  toggle(on = !this.active) {
    this.active = on;
    this.button.setAttribute("aria-pressed", String(on));
    this.view.container.classList.toggle("measuring", on);
    this.chip.hidden = !on;
    this.reset();
    if (on) this.view.container.focus({ preventScroll: true });
  }

  /** Forget the measurement and the snap points (another project). */
  reset() {
    this.a = this.b = this.cur = null;
    this.faceCands.clear();
    this.redraw();
  }

  // ---- Board3D hooks: true = handled ----

  pick(e) {
    if (!this.active) return false;
    const q = this.snap(e);
    if (q) {
      if (!this.a || this.b) {
        this.a = q;
        this.b = null;
      } else this.b = q;
      this.cur = q;
      this.redraw();
    }
    return true;
  }

  hover(e) {
    if (!this.active) return false;
    this.cur = this.snap(e);
    this.redraw();
    return true;
  }

  /** Each rendered frame: keep the label on its point while the camera moves. */
  frame() {
    const end = this.b ?? this.cur;
    if (!this.active || !this.a || !end) return;
    const r = this.view.renderer.domElement.getBoundingClientRect();
    const p = end.w.clone().project(this.view.camera);
    const visible = p.z < 1 && Math.abs(p.x) <= 1.2 && Math.abs(p.y) <= 1.2;
    this.labelEl.hidden = !visible;
    if (visible) {
      this.labelEl.style.left = `${((p.x + 1) / 2) * r.width + 12}px`;
      this.labelEl.style.top = `${((1 - p.y) / 2) * r.height - 12}px`;
    }
  }

  /** What's under the pointer, snapped: {w: world point, label?}, or null over the background. */
  snap(e) {
    const v = this.view;
    const r = v.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    v.raycaster.setFromCamera(ndc, v.camera);
    const targets = v.componentGroup.visible ? [v.componentGroup, v.boardGroup] : [v.boardGroup];
    const hit = v.raycaster.intersectObjects(targets, true)[0] ?? this.faceHit();
    if (!hit) return null;
    let p = hit.point.clone();
    // The face meshes sit a hair off the board (no z-fighting): a point on a
    // face is put on the face itself, so heights are measured from the board.
    const onFace = [v.thickness, 0].find((z) => Math.abs(p.z - z) < 0.01);
    if (onFace !== undefined && !inPart(hit.object)) p = v.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -onFace), new THREE.Vector3()) ?? p;
    if (e.shiftKey) return { w: p };
    // Size of one screen pixel at the hit's depth.
    const px = (2 * v.camera.position.distanceTo(p) * Math.tan(THREE.MathUtils.degToRad(v.camera.fov / 2))) / r.height;
    const tol = SNAP_PX * px;
    let fp = null;
    for (let o = hit.object; o && !fp; o = o.parent) fp = o.userData.footprint ?? null;
    return fp ? this.snapToModel(hit, p, tol, fp) : this.snapToBoard(p, tol);
  }

  /**
   * Where the ray meets the board face towards the camera, for rays that pass
   * through a drilled hole (the middle of a through-hole pad has no geometry).
   */
  faceHit() {
    const v = this.view, bb = v.bbox;
    if (!bb) return null;
    const z = v.camera.position.z > v.thickness / 2 ? v.thickness : 0;
    const point = v.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3());
    if (!point || point.x < bb.x0 || point.x > bb.x1 || -point.y < bb.y0 || -point.y > bb.y1) return null;
    return { point, object: null };
  }

  /** The nearest vertex of the part's model, if one is within reach. */
  snapToModel(hit, p, tol, fp) {
    const pos = hit.object.geometry?.attributes?.position;
    if (!pos || pos.count > MAX_VERTICES) return { w: p };
    const m = hit.object.matrixWorld, q = new THREE.Vector3();
    let best = null, bd = tol;
    for (let i = 0; i < pos.count; i++) {
      q.fromBufferAttribute(pos, i).applyMatrix4(m);
      const d = q.distanceTo(p);
      if (d < bd) {
        bd = d;
        best = q.clone();
      }
    }
    return best ? { w: best, label: `${fp.reference} model` } : { w: p, label: null };
  }

  /** Pads, vias, track ends and outline corners of the face that was hit. */
  snapToBoard(p, tol) {
    const v = this.view;
    if (!v.pcb) return { w: p };
    const face = p.z > v.thickness / 2 ? "front" : "back";
    if (!this.faceCands.has(face)) this.faceCands.set(face, snapPoints(v.pcb, new Set([face === "front" ? "F.Cu" : "B.Cu", "Vias", "Edge.Cuts"]), face));
    const x = p.x, y = -p.y;
    let best = null, bd = tol;
    for (const c of this.faceCands.get(face)) {
      const d = Math.hypot(c.x - x, c.y - y) - (c.r ?? 0);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best ? { w: new THREE.Vector3(best.x, -best.y, face === "front" ? v.thickness : 0), label: best.label } : { w: p };
  }

  redraw() {
    const end = this.b ?? this.cur;
    this.group.visible = this.active && !!(this.a || this.cur);
    this.labelEl.hidden = true;
    if (!this.active) return;
    const set = (obj, pts) => {
      obj.geometry.setFromPoints(pts);
      obj.geometry.computeBoundingSphere();
    };
    this.line.visible = !!(this.a && end);
    if (this.a && end) {
      set(this.line, [this.a.w, end.w]);
      set(this.ends, [this.a.w, end.w]);
    } else if (this.cur) set(this.ends, [this.cur.w]);
    this.snapMark.visible = !!(this.cur?.label && !this.b);
    if (this.snapMark.visible) set(this.snapMark, [this.cur.w]);

    const snapped = this.snapMark.visible ? ` <span class="ms-snapped">${escapeHtml(this.cur.label)}</span>` : "";
    if (this.a && end) {
      const m = measurement3d(this.a.w, end.w);
      this.labelEl.innerHTML = `${m.length.toFixed(3)} mm · ${(m.length / MIL).toFixed(1)} mil<br>Δx ${m.dx.toFixed(3)}  Δy ${m.dy.toFixed(3)}  Δz ${m.dz.toFixed(3)}`;
      this.chip.innerHTML = `<b>${m.length.toFixed(3)} mm</b> <span class="muted">${(m.length / MIL).toFixed(1)} mil</span>${this.b ? "" : ` <span class="muted">· click the second point</span>`}${snapped}`;
      this.frame();
    } else {
      this.chip.innerHTML = `Click the first point on the board or a part <span class="muted">· Shift: no snapping · Esc: stop</span>${snapped}`;
    }
  }

  dispose() {
    this.view.scene.remove(this.group);
    for (const o of this.group.children) {
      o.geometry.dispose();
      o.material.dispose();
    }
    this.button.removeEventListener("click", this._click);
    this.view.container.removeEventListener("pointerdown", this._focus);
    this.view.container.removeEventListener("keydown", this._key);
    this.view.container.classList.remove("measuring");
    this.button.setAttribute("aria-pressed", "false");
    this.chip.hidden = this.labelEl.hidden = true;
    this.view.tool = null;
  }
}

function inPart(o) {
  for (; o; o = o.parent) if (o.userData.footprint) return true;
  return false;
}

/** Distance between two world points, in board terms (Δy along board y, Δz up). */
export function measurement3d(a, b) {
  const dx = b.x - a.x, dy = -(b.y - a.y), dz = b.z - a.z;
  return { dx, dy, dz, length: Math.hypot(dx, dy, dz) };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
