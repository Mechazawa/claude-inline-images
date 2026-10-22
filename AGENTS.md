# Agent notes

- Type-check with `npx -p typescript tsc -p .`. The local `tsconfig.json` is gitignored. It must extend
  `./.claude-plugin/types/tsconfig.json` and add `"lib": ["es2023", "esnext.typedarrays"]`, because the engine
  config lacks the types for `Uint8Array.fromBase64` and `toBase64`, which the runtime has.
- To see what a terminal draws, capture its window: `screencapture -l $(osascript -e 'tell application "iTerm2" to id of current window') -o -x out.png`.
- To release, bump `version` in `.claude-plugin/plugin.json`, commit, then push an annotated tag `vX.Y.Z` with the
  same message. Installed copies only update when that version changes.
- README screenshots: run `Call show_image once on <image> with columns 40. Say nothing else.` in Ghostty
  (`docs/screenshot.png`) and in iTerm2 (`docs/screenshot-iterm2.png`), crop from the tool line to the button row and
  scale to 50%. Do not start Ghostty with `open -na`: the new instance restores every saved window and runs `-e` in
  each.
- The cockpit-skin mod also draws image Reads, in a framed box with a path header. A session with both mods shows a
  Read image twice, so turn one off before you judge what this mod draws.
