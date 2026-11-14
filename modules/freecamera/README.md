# FreeCamera module

ATB discovers this directory through `module.json`. It owns camera pages, WebSocket signaling, authenticated TURN media relay, private STUN, device registration, person detection, local screenshots and recordings.

The existing `/?mode=camera`, `/?mode=viewer`, `/setup`, `/signal` and root JavaScript/CSS URLs remain compatible. `/modules/freecamera/` is the platform entry. Account sessions and certificates come from the platform; camera device and detection preferences keep their existing data filenames. Removing the directory and restarting the platform removes these capabilities while retaining data.

The module opens its listeners in `attach()` and closes them in `close()`. `PUBLIC_ORIGIN` requires an HTTPS IPv4 origin and a valid `TURN_PUBLIC_PORT` while the module is installed. `DETECTION_ENABLED=0` uses an optional desktop compute provider. Native compute loads a model only after the user enables detection, and a lease releases it if the renderer stops responding.

Install dependencies from this directory if the platform distribution does not include them. Prepare the model from the project root with `node modules/freecamera/scripts/setup-model.js`. Source model provenance and integrity metadata live in `models/`.

From the project root:

- `node --test modules/freecamera/test/*.test.js`
- `node modules/freecamera/scripts/browser-test.js`
- `node modules/freecamera/scripts/test-desktop.js`

Desktop code receives validated calls through the generic `atbDesktop.invokeModule('freecamera', action, options)` bridge. The browser adapter lives in `public/desktop-bridge.js`; the platform preload contains no camera methods. Suspending the module flushes recordings and releases native compute. Camera shutdown exposes `window.atbPrepareClose` and the legacy `window.freecameraPrepareClose` alias.

Start the platform from the project root using `Start-ATB.cmd` or `Start-ATB-Desktop.cmd`, then open FreeCamera from the workspace. Desktop service selection is available in the camera page under 摄像头设置 → 连接设置.

The optional hour-aligned Linux archive is described in `RECORDING-ARCHIVE.md`, with source in `archive/` and deployment templates in `deploy/`. It records independent VP8/Opus WebM segments, burns in Beijing time, handles orientation changes, and uploads to the configured regular Baidu Drive directory. Persistent jobs, OAuth refresh, remote verification and precise local cleanup prevent unverified recordings from being deleted. It is a separate server service; the Windows desktop package does not deploy it. Operators supply their own credentials and verify long-term operation.

The camera page requests a duplex AudioSession when supported, preserves environmental sound, and retries persistently system-muted or ended microphones in the foreground at most once per 30 seconds. Silence alone does not trigger reacquisition. Safe diagnostics expose aggregate audio state and bytes, not recorded content. Mobile browsers still require foreground capture, HTTPS and microphone permission.
