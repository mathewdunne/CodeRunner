# AdvantageScope Patches

Patch files in this directory are applied to the vendored `vendor/AdvantageScope`
submodule before building AdvantageScope Lite.

- `001-lite-nt4-endpoint-injection.patch` adds embedded-mode NT4 endpoint
  injection. `/scope/?frcEndpoint=postMessage` waits for the parent page to
  send `frc-sim:set-nt4-endpoint`, acknowledges with
  `frc-sim:nt4-endpoint-ready`, and starts the live NT4 connection with the
  injected alive probe and WebSocket URL.
- `002-field2d-skip-zero-size-render.patch` makes the 2D Field renderer skip
  frames while its container is 0×0, which is the case whenever the shell hides
  the AdvantageScope pane with `display: none`. Unpatched, the heatmap canvas
  shrinks to 0×0 and `drawImage()` throws. That kills the tab render loop, so
  the field stays blank after switching back.

Run `bun run apply:ascope-patches` to apply patches without rebuilding, or
`bun run build:ascope` to apply patches, rebuild the Lite bundle, and stage it
under `dist/advantagescope/`.
