# ATB Assistant

The assistant module owns chat, model settings, persona, manual memory, and optional local speech recognition with online synthesis. Its public entry is /modules/assistant/ and its authenticated HTTP routes retain /api/assistant/*.

The platform provides AccountStore, SharedSettings, and the data directory through docs/MODULES.md. No JavaScript runtime dependencies are required beyond Node 22+. The optional voice setup installs pinned Python packages and verified model files; it does not move an existing Python environment.

From the ATB installation directory, run:

```text
python modules/assistant/scripts/setup-assistant-voice.py
```

Use --data-dir to select the existing data/assistant directory explicitly. ATB_DATA_DIR and FREECAMERA_DATA_DIR are also supported as installation data roots. The worker and setup script are module-owned; Python, downloaded models, voice settings, persona, and memory remain under the platform data directory.

AI connection settings default to the platform's `ai` section in data/platform/settings.json. The assistant model page can select a module-only custom override; saved keys are redacted as `hasApiKey`, never returned to the browser. Selected models appear in the conversation model menu. Switching to platform defaults uses that shared configuration immediately after saving. Legacy connection settings migrate without overwriting an existing platform API.

Persona and memory remain in data/assistant/settings.json. Memory is explicitly saved text included in each model request, with no automatic extraction, vector search, or background summarization. The message action adds the selected text (or the full message) to the memory draft, which still needs Save. Chat history uses sessionStorage for the current browser session; its bounded recent context is sent with each turn.

Voice conversation uses SenseVoice/Silero recognition in the runtime, the selected chat API, online EdgeTTS synthesis, then playback on the user's device. In desktop mode recognition runs locally; plain web HTTP sends PCM utterances to the current authenticated ATB service for recognition. Recognition models and microphone access are only needed for voice conversation. Preview and message read-aloud open an EdgeTTS-only worker (`--synthesis-only`), without loading recognition models or enabling the microphone. A Python runtime with edge_tts is still required for that pathway. If that runtime is unavailable, the page offers browser system speech synthesis, clearly labeled; installed voices and browser support determine availability and the EdgeTTS voice choice does not control system voices. Errors and cancellation are visible and do not count as successful playback.

`node modules/assistant/scripts/test-ui.js` checks inherited API state, custom model selection, chat model dispatch, memory drafts and responsive layout using isolated API fixtures. `node --test modules/assistant/test/voice-controller.test.js modules/assistant/test/voice-runtime.test.js` verifies synthesis-only sessions, cancellation, empty audio, playback errors and system fallback. These deterministic tests do not prove that the physical speaker produced sound; real online synthesis and playback must also be verified in the target environment.

Removing this directory and restarting removes its page, assets, routes, and native handlers. Data stays available for reinstallation. See docs/licenses for component licenses; SenseVoice model terms must be reviewed before distributing downloaded model files.
