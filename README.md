# Sonic Forage Infinite Radio

Public no-build browser prototype for endless prompt-queued generated music.

- WebGPU capability check for browser readiness and future visual/ML acceleration.
- Web Audio A/B deck engine for decoding, looping, and crossfading chunks.
- Deterministic local prompt synthesis fallback, so the public page works without GPU spend.
- Optional Modal backend contract: POST a prompt and return `audio_url` or `audio_base64`.

## Modal backend contract

```json
POST /generate
{ "prompt": "deep echo intergalactic bass", "duration": 16, "crossfade": 4 }
```

Return either:

```json
{ "title": "SA3 chunk", "audio_url": "https://.../chunk.mp3" }
```

or:

```json
{ "title": "SA3 chunk", "audio_base64": "..." }
```

The public page intentionally does not embed secrets or auto-spend GPU.
