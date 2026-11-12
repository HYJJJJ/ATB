# ATB Assistant

The assistant module owns chat, model settings, persona, manual memory, and optional local speech recognition with online synthesis. Its public entry is /modules/assistant/ and its authenticated HTTP routes retain /api/assistant/*.

The platform provides AccountStore, SharedSettings, and the data directory through docs/MODULES.md. No JavaScript runtime dependencies are required beyond Node 22+. The optional voice setup installs pinned Python packages and verified model files; it does not move an existing Python environment.

From the ATB installation directory, run:

```text
python modules/assistant/scripts/setup-assistant-voice.py
```

Use --data-dir to select the existing data/assistant directory explicitly. ATB_DATA_DIR and FREECAMERA_DATA_DIR are also supported as installation data roots. The worker and setup script are module-owned; Python, downloaded models, voice settings, persona, and memory remain under the platform data directory.

AI connection settings are authoritative in data/platform/settings.json under ai. On initialization, legacy data/assistant/settings.json connection settings are imported only if ai does not exist, and the shared update finishes before requests can be served. The legacy file retains historical fields for rollback; subsequent provider changes are written only to shared settings. Persona and memory remain in the legacy assistant file. HTTP responses expose hasApiKey and never the key.

Removing this directory and restarting removes its page, assets, routes, and native handlers. Data stays available for reinstallation. See docs/licenses for component licenses; SenseVoice model terms must be reviewed before distributing downloaded model files.
