export type Shown = { file: string; width: number; height: number; columns?: number }

declare module 'claude-code' {
  interface PluginState {
    'inline-images': { pasted: Record<string, Shown[]> }
  }
}
