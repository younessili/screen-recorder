# Backlog

Items surfaced during plan reviews that are out of scope for the active slice. The owner of each phase decides which to pull in next.

---

## From `2026-04-18-phase-1-mic-stem.md` review

- **Split mic IPC from screen IPC.** Source: Devil's Advocate Finding 3. The current Task 4 Step 3b sends screen + webcam + mic in one `storeRecordedSession` IPC call. At very long recordings approaching the 90-min cap (~830 MB combined payload), Electron's structured-clone serialization could fail and lose the screen recording. Phase 1 mitigates by capping mic capture at 90 min (renderer OOM also bounded), but a cleaner architecture is two separate IPC calls so a failed mic write never takes down the screen save. ~30 LOC.

- **Preserve `micAudioPath` through `.openscreen` project save/load.** Source: Feasibility Concern CN1. `getApprovedProjectSession` (`electron/ipc/handlers.ts:148-163`) and the re-normalization in `loadRecordedSessionForVideoPath` (`handlers.ts:234-243`) only handle `screenVideoPath` + `webcamVideoPath`. The new `micAudioPath` will roundtrip through the normalizer added in Phase 1 but is silently dropped by these two handlers. Low impact (the `.mic.wav` file is still on disk next to the video — user can grab it directly), but inconsistent. Add parallel `micAudioPath` clauses to both handlers.

- **Stream mic samples to disk during recording.** Source: Devil's Advocate Finding 2 follow-up. Phase 1 buffers Float32 in renderer memory (~11.5 MB/min) which caps practical recordings at ~90 min. A streaming-to-disk architecture (PCM chunks → IPC → fs.appendFile in main) removes the cap entirely and aligns with the Phase 2a "save raw on the fly" philosophy in `SPEC.md`. Bigger refactor; reconsider together with Phase 2a.

- **Collapse `RecordedVideoAssetInput` + `RecordedAudioAssetInput` into one `RecordedAssetInput { fileName; data }`.** Source: Simplicity Finding 1. The two types differ only in the field name (`videoData` vs `audioData`) — semantically identical. Rename forces touching `useScreenRecorder.ts`, `handlers.ts`, `electron-env.d.ts`, `preload.ts`, and any future caller of `storeRecordedSession`. Worth doing as a standalone cleanup PR; not worth bundling into Phase 1 where it inflates diff scope and risk for a personal fork.

- **Output buffer zeroing for ScriptProcessorNode.** Source: Feasibility CN2. Defensive `event.outputBuffer.getChannelData(0).fill(0)` in `onaudioprocess` to guarantee silence on the first tick on any non-Chromium engine. Currently relying on Chromium's default-silent behavior, which is verified correct. Defer until/unless we hear a click on recording start in dev.
