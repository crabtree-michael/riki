# Frame-time results

Committed output from `bench/frametime`. Empty until the first run.

The metric is **Dota's 1% low frame time with Riki running versus not** — not average FPS, not
Riki's own CPU usage. Measured on real hardware, on a low-end machine, at 1080p / 1440p / 4K.
This cannot run in CI and cannot be faked, so it runs before a release and the numbers land here.

**A release that has not run it is not a release.**

One file per run, named `YYYY-MM-DD-<gpu>-<resolution>.md`, recording: hardware, OS build, Dota
build, Riki commit, the with/without 1% lows, and total process-tree memory. Memory is not held
to a committed ceiling at this stage, but record it anyway — it is the number
[ADR-0001](../../adr/0001-electron-shell.md) says can invert the choice of Electron.
