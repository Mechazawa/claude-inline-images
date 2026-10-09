import type { EngineInterface, Register } from 'claude-code'

const TOOL = 'show_image'
const FULL_NAME = 'mcp__inline-images__show_image'
const CONVERTED_DIR = '/tmp/claude-inline-images'
const MAX_ROWS = 40
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2

type Shown = { file: string; width: number; height: number; columns?: number }

const pixelSize = async ($: EngineInterface, file: string) => {
  const { stdout } = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file])

  return {
    width: Number(/pixelWidth: (\d+)/.exec(stdout)?.[1] ?? 0),
    height: Number(/pixelHeight: (\d+)/.exec(stdout)?.[1] ?? 0),
  }
}

// The terminal decodes PNG only, so every other format goes through sips first.
const asPng = async ($: EngineInterface, file: string) => {
  if (/\.png$/i.test(file)) {
    return file
  }

  const converted = `${CONVERTED_DIR}/${Date.now()}.png`
  await $.process.run(['mkdir', '-p', CONVERTED_DIR])
  const { exitCode, stderr } = await $.process.run(['sips', '-s', 'format', 'png', file, '--out', converted])

  if (exitCode !== 0) {
    throw new Error(`sips cannot convert ${file} to PNG: ${stderr.trim()}`)
  }

  return converted
}

const cellBox = (shown: Shown, available: number) => {
  const wanted = Math.min(shown.columns ?? 80, available, 255)
  const rows = Math.round((wanted * shown.height) / shown.width / CELL_ASPECT)

  return rows <= MAX_ROWS
    ? { columns: wanted, rows: Math.max(1, rows) }
    : { columns: Math.max(1, Math.round((MAX_ROWS * CELL_ASPECT * shown.width) / shown.height)), rows: MAX_ROWS }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description:
        'Show an image file to the user, drawn inline in their terminal. Use it when the user wants to see an image ' +
        '(a screenshot, a chart, a generated picture). It does not put the image in your context: use Read for that.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or working-directory-relative path of a PNG, JPEG, GIF, WebP, HEIC or TIFF file' },
          columns: { type: 'integer', minimum: 4, maximum: 255, description: 'Width in terminal columns, 80 by default' },
        },
        required: ['path'],
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('tool.call', { tool: FULL_NAME }, async ($, e) => {
    const input = e as { path?: unknown; columns?: unknown }

    if (typeof input.path !== 'string') {
      return { deny: 'path must be a string' }
    }

    const real = (await $.fs.stat(input.path, { resolve: true }).catch(() => undefined))?.realPath

    if (real === undefined) {
      return { deny: `${input.path} does not exist` }
    }

    const file = await asPng($, real)
    const size = await pixelSize($, file)

    if (size.width === 0 || size.height === 0) {
      return { deny: `${input.path} is not an image sips can read` }
    }

    const shown: Shown = { file, ...size, columns: typeof input.columns === 'number' ? input.columns : undefined }

    return { result: JSON.stringify(shown) }
  }).catch(($, e, next) => ({ deny: `show_image failed: ${next.error.message ?? next.error.kind}` }))

  on('ui.render', { component: 'ToolResult', props: { tool: FULL_NAME } }, ($, e, next) => {
    const shown = typeof e.props.output === 'string' ? (JSON.parse(e.props.output) as Shown) : undefined

    if (e.surface !== 'terminal' || e.props.isErrored || shown === undefined) {
      return next(e)
    }

    const { Image } = $.ui.resolve(e)
    const box = cellBox(shown, (e.viewport?.columns ?? 80) - 6)

    return <Image source={{ file: shown.file, format: 'png' }} {...box} alt={shown.file} />
  })
}
