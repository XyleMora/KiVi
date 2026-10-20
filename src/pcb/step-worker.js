// STEP → triangles, off the main thread (src/pcb/step.js runs it):
// occt-import-js takes 0.3–1 s per library model, which on the main thread
// froze the window while a board's models loaded.
//
// A classic worker, not a module: occt-import-js is a plain script that
// defines a global, so it is loaded with importScripts.

importScripts("../../vendor/occt-import-js/occt-import-js.js");

const OCCT_DIR = new URL("../../vendor/occt-import-js/", self.location.href).href;
// eslint-disable-next-line no-undef
const ready = occtimportjs({ locateFile: (name) => OCCT_DIR + name });

/** occt-import-js's result as transferable typed arrays (keep in step with stepPayload in step.js). */
function payload(result) {
  return result.meshes.map((m) => ({
    position: new Float32Array(m.attributes.position.array),
    normal: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
    index: new Uint32Array(m.index.array),
    color: m.color ?? null,
    faces: (m.brep_faces ?? []).filter((f) => f.color).map((f) => ({ first: f.first, last: f.last, color: f.color })),
  }));
}

self.onmessage = async ({ data: { id, buf } }) => {
  let occt;
  try {
    occt = await ready;
  } catch (e) {
    // WebAssembly can't run here: the page converts on its own thread instead.
    self.postMessage({ id, fatal: true, error: String(e?.message ?? e) });
    return;
  }
  try {
    const result = occt.ReadStepFile(new Uint8Array(buf), null);
    if (!result.success) throw new Error("not a readable STEP file");
    const meshes = payload(result);
    const transfer = meshes.flatMap((m) => [m.position.buffer, m.index.buffer, ...(m.normal ? [m.normal.buffer] : [])]);
    self.postMessage({ id, meshes }, transfer);
  } catch (e) {
    self.postMessage({ id, error: String(e?.message ?? e) });
  }
};
