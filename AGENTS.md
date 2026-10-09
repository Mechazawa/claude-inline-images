# Agent notes

- Type-check with `npx -p typescript tsc -p .`. The local `tsconfig.json` is gitignored. It must extend
  `./.claude-plugin/types/tsconfig.json` and add `"lib": ["es2023", "esnext.typedarrays"]`, because the engine
  config lacks the types for `Uint8Array.fromBase64` and `toBase64`, which the runtime has.
- To see what a terminal draws, capture its window: `screencapture -l $(osascript -e 'tell application "iTerm2" to id of current window') -o -x out.png`.
