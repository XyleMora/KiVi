# Vendored dependencies

| Package | Version | License | Files |
|---|---|---|---|
| [occt-import-js](https://github.com/kovacsv/occt-import-js) | 0.0.22 | LGPL-2.1 (`occt-import-js/LICENSE.md`) | `occt-import-js.js`, `occt-import-js.wasm` (STEP reader; see the patch note below) |
| [three.js](https://threejs.org) | 0.169.0 | MIT (`three/LICENSE`) | `three.module.js`, `addons/controls/OrbitControls.js`, `addons/controls/TrackballControls.js`, `addons/loaders/VRMLLoader.js`, `addons/libs/chevrotain.module.min.js` (Chevrotain 9.0.1, Apache-2.0, `three/addons/libs/chevrotain.LICENSE`; bundled by three.js) |

Keep each package's licence file next to it, and update the list in
`tools/notices.py` (then run it) when adding or updating a package.

Vendored rather than loaded from a CDN so the app works offline and its
content security policy can forbid remote scripts.

The addons' `from 'three'` imports were rewritten to `../../three.module.js`
so no import map is required.

`occt-import-js.js` is patched in one place: embind's `craftInvokerFunction`
built its invokers with `new Function`, which the app's content security
policy forbids (it doesn't allow `unsafe-eval`). It was replaced with Emscripten's
own non-eval version (what `-sDYNAMIC_EXECUTION=0` generates); the change is
marked `KiVi patch`. Re-apply it when updating the package.
