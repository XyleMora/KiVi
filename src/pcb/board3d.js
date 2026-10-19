// 3D board view (browser only): extruded board with face textures and
// component models (VRML from the KiCad library or the project). Parts whose
// model cannot be loaded are left out.

import * as THREE from "../../vendor/three/three.module.js";
import { TrackballControls } from "../../vendor/three/addons/controls/TrackballControls.js";
import { boardOutline } from "./outline.js";
import { boardFaceSvg, netOverlaySvg } from "./texture.js";
import { hitTest } from "./hit.js";
import { boardBBox } from "./render.js";

/** Default mirror of KiCad's standard 3D library (VRML files, CORS-enabled). */
export const DEFAULT_MODEL_BASE = "https://raw.githubusercontent.com/KiCad/kicad-packages3D/master/";
const VRML_UNIT = 2.54; // KiCad VRML models are in 0.1 inch units

export class Board3D {
  /**
   * @param {HTMLElement} container
   * @param {object} [opts]
   * @param {(path: string) => AsyncIterable<{url: string, format: "wrl"|"step"}>|Promise<{url: string, format: "wrl"|"step"}|null>} [opts.resolveModel]
   * @param {(msg: string) => void} [opts.onStatus]
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1f24);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    this.camera.up.set(0, 0, 1);
    // Trackball rather than orbit: the board tumbles freely, past the poles and around every axis.
    this.controls = new TrackballControls(this.camera, this.renderer.domElement);
    this.controls.rotateSpeed = 3;
    this.controls.panSpeed = 0.8;
    this.controls.dynamicDampingFactor = 0.15;
    this.controls.keys = []; // its A/S/D modifier keys would clash with the app's shortcuts

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, -1.5, 3);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-2, 1, -2);
    this.scene.add(fill);
    this.key = key;

    this.boardGroup = new THREE.Group();
    this.componentGroup = new THREE.Group();
    this.scene.add(this.boardGroup, this.componentGroup);

    this._resize = () => this.resize();
    this.resizeObserver = new ResizeObserver(this._resize);
    this.resizeObserver.observe(container);
    this.resize();
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(loop);
    };
    loop();
    this.modelCache = new Map();

    // Click (without dragging) picks a component.
    this.raycaster = new THREE.Raycaster();
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", (e) => (this._down = { x: e.clientX, y: e.clientY }));
    el.addEventListener("pointerup", (e) => {
      const d = this._down;
      this._down = null;
      if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      const { fp, net } = this.pick(e);
      this.select(fp?.reference ?? null);
      this.highlightNet(net ?? null);
      this.opts.onPick?.(fp ?? null, net ?? null);
    });
  }

  /**
   * What is under a pointer event: a component, or on the board face a pad
   * (its footprint and net), a track/via (its net) or a footprint area.
   * @returns {{fp?: object, net?: string}}
   */
  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    if (this.componentGroup.visible) {
      for (const hit of this.raycaster.intersectObject(this.componentGroup, true)) {
        for (let o = hit.object; o; o = o.parent) if (o.userData.footprint) return { fp: o.userData.footprint };
      }
    }
    const hit = this.raycaster.intersectObject(this.boardGroup, true)[0];
    if (!hit || !this.pcb) return {};
    const x = hit.point.x, y = -hit.point.y;
    const side = hit.point.z > this.thickness / 2 ? "front" : "back";
    // Copper on the face that was clicked.
    const cu = hitTest(this.pcb, x, y, new Set([side === "back" ? "B.Cu" : "F.Cu"]), side, 0.15);
    if (cu?.kind === "pad") return { fp: cu.footprint, net: cu.pad.net || null };
    if (cu?.kind === "track" || cu?.kind === "via") return { net: (cu.track ?? cu.via).net || null };
    // Parts without a model: the footprint under that point.
    let best = null, area = Infinity;
    for (const fp of this.pcb.footprints) {
      if (fp.side !== side) continue;
      const b = footprintBox(fp);
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      const a = (b.x1 - b.x0) * (b.y1 - b.y0);
      if (a < area) {
        area = a;
        best = fp;
      }
    }
    return best ? { fp: best } : {};
  }

  /**
   * Highlight a net on both faces (null clears). Copper on other layers shows
   * fainter through each face so the whole net reads from either side.
   * @returns {Promise<boolean>} whether the net exists on the board
   */
  async highlightNet(net, { focus = false } = {}) {
    const token = (this._netToken = (this._netToken ?? 0) + 1);
    for (const m of this.netMeshes ?? []) {
      this.boardGroup.remove(m);
      m.material.map?.dispose();
      m.material.dispose();
    }
    this.netMeshes = [];
    this.highlightedNet = net || null;
    if (!net || !this.pcb || !this.capGeo) return false;
    const exists = this.pcb.tracks.some((t) => t.net === net) || this.pcb.footprints.some((f) => f.pads.some((p) => p.net === net)) || this.pcb.zones.some((z) => z.net === net);
    if (!exists) {
      this.highlightedNet = null;
      return false;
    }
    const bb = this.bbox;
    const [top, bottom] = await Promise.all(["front", "back"].map((side) => this.svgTexture(netOverlaySvg(this.pcb, side, net, bb), bb, 10)));
    if (token !== this._netToken) {
      top.dispose();
      bottom.dispose();
      return true; // superseded by a newer highlight
    }
    const mat = (map, side) => new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, side, toneMapped: false });
    const a = new THREE.Mesh(this.capGeo, mat(top, THREE.FrontSide));
    a.position.z = this.thickness + 0.02;
    const b = new THREE.Mesh(this.capGeo, mat(bottom, THREE.BackSide));
    b.position.z = -0.02;
    a.renderOrder = b.renderOrder = 5;
    this.netMeshes = [a, b];
    this.boardGroup.add(a, b);
    if (focus) this.focusOn(this.netBox3(net));
    return true;
  }

  /** World box around a net's pads and tracks. */
  netBox3(net) {
    const box = new THREE.Box3();
    const z0 = 0, z1 = this.thickness;
    const add = (x, y) => (box.expandByPoint(new THREE.Vector3(x, -y, z0)), box.expandByPoint(new THREE.Vector3(x, -y, z1)));
    for (const t of this.pcb.tracks) if (t.net === net) (add(t.start.x, t.start.y), add(t.end.x, t.end.y));
    for (const fp of this.pcb.footprints) for (const p of fp.pads) if (p.net === net) add(p.x, p.y);
    return box;
  }

  /**
   * Highlight a component by reference (null clears). With `focus`, the camera
   * moves to it. Works before its model has loaded: placement re-applies it.
   * @returns {boolean} whether the reference exists on the board
   */
  select(ref, { focus = false } = {}) {
    this.clearSelection();
    this.selectedRef = ref || null;
    if (!ref || !this.pcb) return false;
    const fp = this.pcb.footprints.find((f) => f.reference === ref);
    if (!fp) {
      this.selectedRef = null;
      return false;
    }
    for (const g of this.componentGroup.children) if (g.userData.footprint === fp) this.tint(g, true);
    this.updateSelectionBox();
    if (focus) this.focusOn(this.selectionBox3());
    return true;
  }

  clearSelection() {
    for (const g of this.componentGroup.children) if (g.userData.tinted) this.tint(g, false);
    if (this.selBox) {
      this.scene.remove(this.selBox);
      this.selBox.geometry.dispose();
      this.selBox.material.dispose();
      this.selBox = null;
    }
    this.selectedRef = null;
  }

  /** Swap in tinted material copies (models share cached materials). */
  tint(group, on) {
    group.userData.tinted = on;
    group.traverse((o) => {
      if (!o.isMesh) return;
      if (on) {
        if (o.userData.origMaterial) return;
        o.userData.origMaterial = o.material;
        const tintOne = (m) => {
          const c = m.clone();
          if (c.emissive) {
            c.emissive = new THREE.Color(0xf0a63b);
            c.emissiveIntensity = 0.45;
          } else if (c.color) c.color.lerp(new THREE.Color(0xf0a63b), 0.5);
          return c;
        };
        o.material = Array.isArray(o.material) ? o.material.map(tintOne) : tintOne(o.material);
      } else if (o.userData.origMaterial) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
        o.material = o.userData.origMaterial;
        delete o.userData.origMaterial;
      }
    });
  }

  /** World-space box of the selection: its models, else its footprint area. */
  selectionBox3() {
    const fp = this.pcb?.footprints.find((f) => f.reference === this.selectedRef);
    if (!fp) return null;
    const box = new THREE.Box3();
    for (const g of this.componentGroup.children) if (g.userData.footprint === fp) box.expandByObject(g);
    if (box.isEmpty()) {
      const b = footprintBox(fp);
      const z = fp.side === "back" ? 0 : this.thickness;
      box.set(new THREE.Vector3(b.x0, -b.y1, z - 0.05), new THREE.Vector3(b.x1, -b.y0, z + 0.05));
    }
    return box;
  }

  updateSelectionBox() {
    if (this.selBox) {
      this.scene.remove(this.selBox);
      this.selBox.geometry.dispose();
      this.selBox.material.dispose();
      this.selBox = null;
    }
    const box = this.selectionBox3();
    if (!box) return;
    box.expandByScalar(0.3);
    this.selBox = new THREE.Box3Helper(box, 0xf0a63b);
    this.selBox.material.depthTest = false; // stay visible through the board and other parts
    this.selBox.material.transparent = true;
    this.selBox.renderOrder = 10;
    this.scene.add(this.selBox);
  }

  /** Glide the camera to `box`, keeping the current viewing direction. */
  focusOn(box) {
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 12);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    // Look at bottom-side parts from below.
    const fp = this.pcb.footprints.find((f) => f.reference === this.selectedRef);
    if (fp?.side === "back" && dir.z > 0) dir.z = -dir.z;
    if (fp?.side !== "back" && dir.z < 0) dir.z = -dir.z;
    const to = center.clone().addScaledVector(dir, size * 2.2);
    const fromPos = this.camera.position.clone(), fromTarget = this.controls.target.clone();
    const t0 = performance.now(), dur = 450;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.position.lerpVectors(fromPos, to, e);
      this.controls.target.lerpVectors(fromTarget, center, e);
      this.controls.update();
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }

  /** Called when a component is added to the scene (models load asynchronously). */
  componentAdded(group) {
    if (!this.selectedRef || group.userData.footprint?.reference !== this.selectedRef) return;
    this.tint(group, true);
    this.updateSelectionBox();
  }

  resize() {
    const w = this.container.clientWidth || 800, h = this.container.clientHeight || 600;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.controls?.handleResize();
  }

  status(msg) {
    this.opts.onStatus?.(msg);
  }

  async load(pcb) {
    this.clear();
    this.pcb = pcb;
    const t = pcb.thickness || 1.6;
    this.thickness = t;
    const bb = boardBBox(pcb);
    this.bbox = bb;

    this.status("Building board…");
    const { outer, holes } = boardOutline(pcb);
    const outline = outer ?? [
      { x: bb.x0, y: bb.y0 },
      { x: bb.x1, y: bb.y0 },
      { x: bb.x1, y: bb.y1 },
      { x: bb.x0, y: bb.y1 },
    ];
    const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, -p.y)));
    for (const h of holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, -p.y))));
    // Drilled holes: pads only (vias are painted on the texture).
    let drillCount = 0;
    for (const fp of pcb.footprints) {
      for (const p of fp.pads) {
        if (!p.drill || drillCount > 4000) continue;
        const pts = drillOutline(p);
        if (pts) {
          shape.holes.push(new THREE.Path(pts.map((q) => new THREE.Vector2(q.x, -q.y))));
          drillCount++;
        }
      }
    }

    const sideMat = new THREE.MeshStandardMaterial({ color: 0xb79b5b, roughness: 0.8, metalness: 0.0 });
    const hiddenCap = new THREE.MeshBasicMaterial({ visible: false });
    const sides = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 12 }), [hiddenCap, sideMat]);
    this.boardGroup.add(sides);

    const capGeo = new THREE.ShapeGeometry(shape, 12);
    this.capGeo = capGeo;
    const [topTex, botTex] = await Promise.all([this.faceTexture(pcb, "front", bb), this.faceTexture(pcb, "back", bb)]);
    const top = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.55, metalness: 0.05 }));
    top.position.z = t + 0.002;
    const bottom = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({ map: botTex, roughness: 0.55, metalness: 0.05, side: THREE.BackSide }));
    bottom.position.z = -0.002;
    this.boardGroup.add(top, bottom);

    this.frame("iso");
    this.status("");
    // Components load in the background.
    this.loadComponents(pcb).catch((e) => this.status(`3D models: ${e.message}`));
  }

  faceTexture(pcb, side, bb) {
    return this.svgTexture(boardFaceSvg(pcb, side, bb).svg, bb, 20);
  }

  /** Rasterize board-coordinate SVG artwork into a texture for the face meshes. */
  async svgTexture(svg, bb, maxPpm) {
    const maxTex = Math.min(this.renderer.capabilities.maxTextureSize, 8192);
    const ppm = Math.min(maxPpm, maxTex / Math.max(bb.w, bb.h));
    const w = Math.max(1, Math.round(bb.w * ppm)), h = Math.max(1, Math.round(bb.h * ppm));
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const img = new Image(w, h);
      img.src = url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      // ShapeGeometry UVs are the shape coordinates (x, -y): map them onto the image.
      tex.repeat.set(1 / bb.w, 1 / bb.h);
      tex.offset.set(-bb.x0 / bb.w, bb.y1 / bb.h);
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      return tex;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async loadComponents(pcb) {
    const resolve = this.opts.resolveModel;
    const jobs = [];
    let loaded = 0;
    this.missingModels = [];
    const report = () => {
      const missing = this.missingModels.length;
      this.status(`3D models: ${loaded} loaded${missing ? `, ${missing} not found` : ""}`);
    };
    for (const fp of pcb.footprints) {
      if (fp.attrs.includes("board_only")) continue;
      for (const m of fp.models.filter((m) => !m.hide && m.path)) {
        jobs.push(async () => {
          let obj = null;
          if (resolve) {
            try {
              // Candidates in priority order; the first that loads wins.
              const r = resolve(m.path);
              const candidates = r?.[Symbol.asyncIterator] ? r : [await r].filter(Boolean);
              for await (const c of candidates) if (c && (obj = await this.loadModel(c))) break;
            } catch {
              obj = null;
            }
          }
          if (obj) {
            this.placeModel(fp, m, obj, obj.userData.unit ?? 1);
            loaded++;
          } else {
            this.missingModels.push({ reference: fp.reference, path: m.path });
          }
          report();
        });
      }
    }
    await runLimited(jobs, 6);
    if (jobs.length) report();
    else this.status("");
    this.opts.onModelsLoaded?.(this.missingModels);
  }

  async loadModel({ url, format }) {
    if (!this.modelCache.has(url)) {
      this.modelCache.set(
        url,
        (async () => {
          if (format === "wrl") {
            const { VRMLLoader } = await import("../../vendor/three/addons/loaders/VRMLLoader.js");
            const text = await (await fetchOk(url)).text();
            const obj = new VRMLLoader().parse(text, url.slice(0, url.lastIndexOf("/") + 1));
            obj.userData.unit = VRML_UNIT;
            obj.traverse((o) => {
              if (o.isMesh && o.material) {
                for (const mat of Array.isArray(o.material) ? o.material : [o.material]) mat.side = THREE.DoubleSide;
              }
            });
            return obj;
          }
          if (format === "step") return loadStep(url);
          return null;
        })().catch(() => null),
      );
    }
    const proto = await this.modelCache.get(url);
    return proto ? proto.clone() : null;
  }

  /** KiCad model placement: footprint pose, side flip, then model offset/rotation/scale. */
  placeModel(fp, m, obj, unit) {
    const g = new THREE.Group();
    g.position.set(fp.x, -fp.y, fp.side === "back" ? 0 : this.thickness);
    g.rotation.z = (fp.angle * Math.PI) / 180;
    const flip = new THREE.Group();
    if (fp.side === "back") flip.rotation.x = Math.PI;
    const inner = new THREE.Group();
    inner.position.set(m.offset.x, m.offset.y, m.offset.z);
    inner.rotation.set((-m.rotate.x * Math.PI) / 180, (-m.rotate.y * Math.PI) / 180, (-m.rotate.z * Math.PI) / 180, "ZYX");
    inner.scale.set(m.scale.x * unit, m.scale.y * unit, m.scale.z * unit);
    inner.add(obj);
    flip.add(inner);
    g.add(flip);
    g.userData.footprint = fp;
    this.componentGroup.add(g);
    this.componentAdded(g);
  }

  setComponentsVisible(v) {
    this.componentGroup.visible = v;
  }

  frame(view = "iso") {
    const bb = this.bbox;
    if (!bb) return;
    const c = new THREE.Vector3((bb.x0 + bb.x1) / 2, -(bb.y0 + bb.y1) / 2, this.thickness / 2);
    const r = Math.max(bb.w, bb.h);
    const dist = r * 1.35;
    const dirs = {
      iso: new THREE.Vector3(0.0, -0.9, 1.1),
      top: new THREE.Vector3(0, -0.0001, 1),
      bottom: new THREE.Vector3(0, 0.0001, -1),
      front: new THREE.Vector3(0, -1, 0.15),
    };
    const dir = (dirs[view] ?? dirs.iso).clone().normalize();
    // Free rotation tilts the camera's up vector; preset views start upright again.
    this.camera.up.set(0, 0, 1);
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.camera.near = r / 200;
    this.camera.far = r * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
  }

  clear() {
    this.clearSelection();
    this._netToken = (this._netToken ?? 0) + 1;
    this.netMeshes = [];
    this.highlightedNet = null;
    for (const grp of [this.boardGroup, this.componentGroup]) {
      for (const o of [...grp.children]) {
        grp.remove(o);
        o.traverse?.((n) => {
          n.geometry?.dispose?.();
          const mats = Array.isArray(n.material) ? n.material : n.material ? [n.material] : [];
          for (const m of mats) {
            m.map?.dispose?.();
            m.dispose?.();
          }
        });
      }
    }
  }

  dispose() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    this.resizeObserver.disconnect();
    this.clear();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  snapshot() {
    return this.renderer.domElement.toDataURL("image/png");
  }
}

/** Footprint extent in board coordinates (pads and courtyard/fab graphics). */
function footprintBox(fp) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const p of fp.pads) {
    const r = Math.max(p.w, p.h) / 2;
    add(p.x - r, p.y - r);
    add(p.x + r, p.y + r);
  }
  for (const g of fp.graphics) {
    if (!/CrtYd|Fab/.test(g.layer)) continue;
    if (g.kind === "line") (add(g.start.x, g.start.y), add(g.end.x, g.end.y));
    else if (g.kind === "poly") for (const p of g.pts) p.arc ? add(p.start.x, p.start.y) : add(p.x, p.y);
    else if (g.kind === "circle") (add(g.center.x - g.r, g.center.y - g.r), add(g.center.x + g.r, g.center.y + g.r));
  }
  if (!Number.isFinite(x0)) (add(fp.x - 1, fp.y - 1), add(fp.x + 1, fp.y + 1));
  return { x0, y0, x1, y1 };
}

function drillOutline(pad) {
  const d = pad.drill;
  const r = Math.min(d.w, d.h) / 2;
  if (r <= 0) return null;
  const a = (pad.angle * Math.PI) / 180;
  const ox = d.offset.x * Math.cos(a) + d.offset.y * Math.sin(a);
  const oy = -d.offset.x * Math.sin(a) + d.offset.y * Math.cos(a);
  const cx = pad.x + ox, cy = pad.y + oy;
  const n = Math.max(12, Math.min(48, Math.round(r * 24)));
  if (!d.oval || Math.abs(d.w - d.h) < 1e-6) {
    const pts = [];
    for (let i = 0; i < n; i++) pts.push({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) });
    return pts;
  }
  // Slot: two semicircles joined, along the longer axis, rotated by the pad angle.
  const long = Math.max(d.w, d.h) / 2 - r;
  const horizontal = d.w >= d.h;
  const pts = [];
  const half = Math.max(6, n / 2);
  for (let i = 0; i <= half; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / half;
    pts.push({ x: long + r * Math.cos(t), y: r * Math.sin(t) });
  }
  for (let i = 0; i <= half; i++) {
    const t = Math.PI / 2 + (Math.PI * i) / half;
    pts.push({ x: -long + r * Math.cos(t), y: r * Math.sin(t) });
  }
  const rot = horizontal ? 0 : Math.PI / 2;
  const ang = rot - a; // screen CCW
  return pts.map((p) => ({ x: cx + p.x * Math.cos(ang) - p.y * Math.sin(ang), y: cy + p.x * Math.sin(ang) + p.y * Math.cos(ang) }));
}

async function fetchOk(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
}

async function runLimited(jobs, n) {
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) await jobs[i++]();
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
}

// ---- STEP (optional, lazy) --------------------------------------------------

// Bundled (not from a CDN): the app works offline and the CSP allows no remote scripts.
const OCCT_URL = new URL("../../vendor/occt-import-js/", import.meta.url).href;
let occtPromise = null;

/** STEP import via occt-import-js (WASM, loaded on first use only). */
async function loadStep(url) {
  occtPromise ??= (async () => {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = OCCT_URL + "occt-import-js.js";
      s.onload = res;
      s.onerror = () => rej(new Error("occt-import-js failed to load"));
      document.head.appendChild(s);
    });
    // eslint-disable-next-line no-undef
    return occtimportjs({ locateFile: (name) => OCCT_URL + name });
  })();
  const occt = await occtPromise;
  const buf = new Uint8Array(await (await fetchOk(url)).arrayBuffer());
  const res = occt.ReadStepFile(buf, null);
  if (!res.success) return null;
  const group = new THREE.Group();
  for (const m of res.meshes) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) geo.setAttribute("normal", new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    geo.setIndex(m.index.array);
    if (!m.attributes.normal) geo.computeVertexNormals();
    const color = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : new THREE.Color(0x888888);
    group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide })));
  }
  group.userData.unit = 1;
  return group;
}

