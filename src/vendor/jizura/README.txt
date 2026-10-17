JIZURA v0.10.1 — Lyric Motion Video Engine
MIT License, Copyright (c) 2026 hakoniwa
Source: https://github.com/852wa/JIZURA

This directory vendors the JIZURA lyric-video rendering engine (src/*.js as of
upstream v0.10.1) for use as the render core of the PvScene lyric animation
scene in this music player.

Excluded from upstream src/:
  - 11_export.js  (MP4 export; depends on mp4-muxer, not needed here)
  - 12_ui.js      (JIZURA editor UI; depends on its own DOM)

Load order matters: files are injected in filename dictionary order
(same as upstream build.py), 01_util.js first (defines the shared `J`
namespace), then all remaining files.

See LICENSE (MIT) and THIRD_PARTY_NOTICES.md in this directory.
