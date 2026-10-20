// STEP models for the 3D view (browser only). Turning a STEP file into
// triangles (occt-import-js, WebAssembly) takes 0.3–1 s per KiCad library
// model, and KiCad 10's library is STEP only, so:
//   - it runs in a worker (step-worker.js), so the window stays responsive;
//   - the triangles are kept in IndexedDB by the file's SHA-256, so a model is
//     converted once, whichever source it came from (as KiCad's own 3D cache
//     does), and opening a board again only reads them back.
// Without workers it falls back to converting on the main thread, and without
// IndexedDB or crypto.subtle it just doesn't cache.

import * as THREE from "../../vendor/three/three.module.js";

/** Part of the cache key: bump when the payload or the conversion changes. */
const CACHE_VERSION = 1;
/** Payloads bigger than this (huge vendor models) aren't cached. */
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
/** A conversion that takes longer is given up (the worker is replaced). */
const JOB_TIMEOUT_MS = 120_000;
/** Shapes without a colour in the STEP file. */
const STEP_GREY = [0.53, 0.53, 0.53];

/**
 * A STEP file as a three.js group (sizes in mm), or null if it can't be read.
 * @param {ArrayBuffer} buf file contents
 */
export async function loadStepModel(buf) {
  const key = await digest(buf);
  let meshes = key ? await cacheGet(key) : undefined;
  if (!meshes) {
    meshes = await convert(buf);
    if (key && meshes && payloadBytes(meshes) <= CACHE_MAX_BYTES) cachePut(key, meshes);
  }
  return meshes ? buildGroup(meshes) : null;
}

// ---- conversion: worker pool, main-thread fallback ------------------------------

// One worker. More were slower in WebKitGTK: each compiles occt-import-js's
// 7.7 MB of WebAssembly, and three cold workers took 25 s for what one does in
// 6 s; on a whole board (CM5_MINIMA_3, 19 STEP models) three took 25 s, one
// 22 s, the main thread 19 s. The cache is what makes reopening fast.
const POOL_SIZE = 1;
const idle = []; // workers waiting for a job
const queue = []; // jobs waiting for a worker: {buf, resolve}
let started = 0;
let workersBroken = false; // a worker failed to start (e.g. blocked): convert on the main thread
let nextId = 0;

function convert(buf) {
  if (workersBroken) return convertHere(buf);
  return new Promise((resolve) => {
    queue.push({ buf, resolve });
    pump();
  });
}

function pump() {
  while (queue.length) {
    let w = idle.pop();
    if (!w && started < POOL_SIZE) w = startWorker();
    if (!w) return; // all busy: the next finished job calls pump()
    run(w, queue.shift());
  }
}

function startWorker() {
  try {
    started++;
    return new Worker(new URL("./step-worker.js", import.meta.url)); // classic: it uses importScripts
  } catch {
    started--;
    fallBack();
    return null;
  }
}

/** Workers can't be used: everything queued and to come converts on the main thread. */
function fallBack() {
  workersBroken = true;
  for (const job of queue.splice(0)) convertHere(job.buf).then(job.resolve);
}

function run(w, job) {
  const id = nextId++;
  const finish = (keep) => {
    clearTimeout(timer);
    w.onmessage = w.onerror = null;
    if (keep) idle.push(w);
    else {
      w.terminate();
      started--;
    }
  };
  // The worker can't run occt-import-js at all (script or WebAssembly blocked):
  // this job and all others go to the main thread. The buffer was copied, not
  // transferred, so it is still here to convert.
  const broken = () => {
    finish(false);
    queue.unshift(job);
    fallBack();
  };
  w.onmessage = ({ data }) => {
    if (data.id !== id) return;
    if (data.fatal) return broken();
    finish(true);
    job.resolve(data.error ? null : data.meshes);
    pump();
  };
  w.onerror = (e) => {
    e.preventDefault?.();
    broken();
  };
  const timer = setTimeout(() => {
    finish(false); // stuck on one model: drop it, a new worker takes the next
    job.resolve(null);
    pump();
  }, JOB_TIMEOUT_MS);
  w.postMessage({ id, buf: job.buf });
}

/** occt-import-js's result as plain typed arrays (keep in step with payload() in step-worker.js). */
function stepPayload(result) {
  return result.meshes.map((m) => ({
    position: new Float32Array(m.attributes.position.array),
    normal: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
    index: new Uint32Array(m.index.array),
    color: m.color ?? null,
    faces: (m.brep_faces ?? []).filter((f) => f.color).map((f) => ({ first: f.first, last: f.last, color: f.color })),
  }));
}

const OCCT_URL = new URL("../../vendor/occt-import-js/", import.meta.url).href;
let occtHere = null;

async function convertHere(buf) {
  try {
    occtHere ??= (async () => {
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
    const result = (await occtHere).ReadStepFile(new Uint8Array(buf), null);
    return result.success ? stepPayload(result) : null;
  } catch {
    return null;
  }
}

// ---- three.js meshes ----------------------------------------------------------------

function buildGroup(meshes) {
  const group = new THREE.Group();
  const materials = new Map(); // "r,g,b" → material, shared by the model's meshes
  const material = (rgb) => {
    const key = rgb.join(",");
    if (!materials.has(key)) {
      // STEP colours are sRGB, as VRML's are (VRMLLoader converts the same way).
      const color = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
      materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide }));
    }
    return materials.get(key);
  };
  for (const m of meshes) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(m.position, 3));
    if (m.normal) geo.setAttribute("normal", new THREE.BufferAttribute(m.normal, 3));
    geo.setIndex(new THREE.BufferAttribute(m.index, 1));
    if (!m.normal) geo.computeVertexNormals();
    const base = m.color ?? STEP_GREY;
    // KiCad's library (and most vendor models) colour each face, not the whole
    // shape: the body black, terminals tin. Faces are triangle ranges.
    if (!m.faces.length) {
      group.add(new THREE.Mesh(geo, material(base)));
      continue;
    }
    const mats = [];
    const slot = (rgb) => {
      const mat = material(rgb);
      let i = mats.indexOf(mat);
      if (i < 0) i = mats.push(mat) - 1;
      return i;
    };
    let next = 0; // triangles not covered by a coloured face keep the shape's colour
    for (const f of [...m.faces].sort((a, b) => a.first - b.first)) {
      if (f.first > next) geo.addGroup(next * 3, (f.first - next) * 3, slot(base));
      geo.addGroup(f.first * 3, (f.last - f.first + 1) * 3, slot(f.color));
      next = f.last + 1;
    }
    const triangles = m.index.length / 3;
    if (next < triangles) geo.addGroup(next * 3, (triangles - next) * 3, slot(base));
    group.add(new THREE.Mesh(geo, mats));
  }
  group.userData.unit = 1;
  return group;
}

// ---- cache ------------------------------------------------------------------------

async function digest(buf) {
  try {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    return `${CACHE_VERSION}:${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null; // no crypto.subtle (not a secure context): no cache
  }
}

const payloadBytes = (meshes) => meshes.reduce((n, m) => n + m.position.byteLength + m.index.byteLength + (m.normal?.byteLength ?? 0), 0);

let dbPromise = null;
function db() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("kivi-models", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("step");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function idb(mode, fn) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction("step", mode);
      const req = fn(tx.objectStore("step"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return undefined; // no IndexedDB, or full: convert again next time
  }
}

const cacheGet = (key) => idb("readonly", (s) => s.get(key));
const cachePut = (key, meshes) => idb("readwrite", (s) => s.put(meshes, key));
