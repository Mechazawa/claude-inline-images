import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Shown } from '../types'

const TOOL = 'show_image'
const FULL_NAME = 'mcp__inline-images__show_image'
const CONVERTED_DIR = '/tmp/claude-inline-images'
const MAX_ROWS = 40
const PASTED_COLUMNS = 40
const READ_COLUMNS = 60
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2
const DEFAULT_COLOR = 0x01000000
const SPACE = 0x20
const UPPER_HALF_BLOCK = 0x2580
const LOWER_HALF_BLOCK = 0x2584

// The BMP must be 24-bit, or 32-bit with alpha in the fourth byte, for rasterCells to read it.
type Converter = {
  binaries: string[]
  size: (file: string) => string[]
  png: (file: string, out: string) => string[]
  bmp: (file: string, out: string, columns: number, rows: number) => string[]
}

const imageMagick = (binary: string): Converter => ({
  binaries: [binary],
  size: file => [binary, `${file}[0]`, '-format', 'width=%w height=%h', 'info:'],
  png: (file, out) => [binary, `${file}[0]`, `png:${out}`],
  bmp: (file, out, columns, rows) => [
    binary, `${file}[0]`, '-resize', `${columns}x${rows}!`, '-type', 'TrueColorAlpha', '-define', 'bmp:format=bmp4', `bmp:${out}`,
  ],
})

const CONVERTERS: Converter[] = [
  {
    binaries: ['sips'],
    size: file => ['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file],
    png: (file, out) => ['sips', '-s', 'format', 'png', file, '--out', out],
    bmp: (file, out, columns, rows) => ['sips', '-s', 'format', 'bmp', '-z', String(rows), String(columns), file, '--out', out],
  },
  imageMagick('magick'),
  imageMagick('convert'),
  {
    binaries: ['ffmpeg', 'ffprobe'],
    size: file => ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'default=nw=1', file],
    png: (file, out) => ['ffmpeg', '-y', '-v', 'error', '-i', file, '-frames:v', '1', out],
    bmp: (file, out, columns, rows) => [
      'ffmpeg', '-y', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${columns}:${rows}`, '-pix_fmt', 'bgra', out,
    ],
  },
]

const findConverter = async ($: EngineInterface) => {
  const found = await Promise.all(
    CONVERTERS.map(async candidate => {
      const checks = await Promise.all(candidate.binaries.map(binary => $.process.run(['sh', '-c', `command -v ${binary}`])))

      return checks.every(check => check.exitCode === 0) ? candidate : undefined
    }),
  )

  return found.find(candidate => candidate !== undefined)
}

let converter: Promise<Converter | undefined> | undefined

const run = async ($: EngineInterface, argv: string[]) => {
  await $.process.run(['mkdir', '-p', CONVERTED_DIR])
  const { exitCode, stdout, stderr } = await $.process.run(argv)

  if (exitCode !== 0) {
    throw new Error(`${argv[0]} failed: ${stderr.trim()}`)
  }

  return stdout
}

const pixelSize = async ($: EngineInterface, using: Converter, file: string) => {
  const stdout = await run($, using.size(file)).catch(() => '')

  return {
    width: Number(/width[:=] ?(\d+)/i.exec(stdout)?.[1] ?? 0),
    height: Number(/height[:=] ?(\d+)/i.exec(stdout)?.[1] ?? 0),
  }
}

// The terminal decodes PNG only, so every other format is converted first.
const asPng = async ($: EngineInterface, using: Converter, file: string) => {
  if (/\.png$/i.test(file)) {
    return file
  }

  const converted = `${CONVERTED_DIR}/${Date.now()}.png`
  await run($, using.png(file, converted))

  return converted
}

const cellBox = (shown: Shown, available: number) => {
  const wanted = Math.min(shown.columns ?? 80, available, 255)
  const rows = Math.round((wanted * shown.height) / shown.width / CELL_ASPECT)

  return rows <= MAX_ROWS
    ? { columns: wanted, rows: Math.max(1, rows) }
    : { columns: Math.max(1, Math.round((MAX_ROWS * CELL_ASPECT * shown.width) / shown.height)), rows: MAX_ROWS }
}

// Terminals without kitty graphics get the picture as half blocks: each cell shows two stacked pixels.
const rasterCells = async ($: EngineInterface, using: Converter, file: string, columns: number, rows: number) => {
  const bmp = `${CONVERTED_DIR}/${Date.now()}-${columns}x${rows}.bmp`
  await run($, using.bmp(file, bmp, columns, rows * 2))
  const { base64 } = await $.fs.read(bmp, { as: 'bytes' })
  const view = new DataView(Uint8Array.fromBase64(base64).buffer)
  const offset = view.getUint32(10, true)
  const height = view.getInt32(22, true)
  const bytesPerPixel = view.getUint16(28, true) / 8
  const stride = Math.ceil((columns * bytesPerPixel) / 4) * 4

  const pixel = (x: number, y: number) => {
    const at = offset + (height < 0 ? y : height - 1 - y) * stride + x * bytesPerPixel

    return bytesPerPixel === 4 && view.getUint8(at + 3) < 128
      ? DEFAULT_COLOR
      : (view.getUint8(at + 2) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at)
  }

  const words = Array.from({ length: columns * rows }, (_, cell) => {
    const x = cell % columns
    const top = pixel(x, Math.floor(cell / columns) * 2)
    const bottom = pixel(x, Math.floor(cell / columns) * 2 + 1)

    if (top !== DEFAULT_COLOR) {
      return [UPPER_HALF_BLOCK, top, bottom]
    }

    return [bottom === DEFAULT_COLOR ? SPACE : LOWER_HALF_BLOCK, bottom, DEFAULT_COLOR]
  }).flat()

  return new Uint8Array(Uint32Array.from(words).buffer).toBase64()
}

const rasters = new Map<string, Promise<string>>()

const describe = async ($: EngineInterface, using: Converter, path: string, columns?: number): Promise<Shown> => {
  const file = await asPng($, using, path)
  const size = await pixelSize($, using, file)

  if (size.width === 0 || size.height === 0) {
    throw new Error(`${path} is not an image ${using.binaries[0]} can read`)
  }

  return { file, ...size, columns }
}

const picture = async ($: EngineInterface, { Image, Raster }: Elements['terminal'], shown: Shown, available: number, key: string) => {
  const box = cellBox(shown, available)

  if ((await $.env.get('TERM_PROGRAM')) === 'ghostty' || (await $.env.get('TERM')) === 'xterm-kitty') {
    return <Image source={{ file: shown.file, format: 'png' }} {...box} alt={shown.file} />
  }

  const using = await (converter ??= findConverter($))

  if (using === undefined) {
    return undefined
  }

  const cacheKey = `${shown.file}:${box.columns}x${box.rows}`
  const cells = rasters.get(cacheKey) ?? rasterCells($, using, shown.file, box.columns, box.rows)
  rasters.set(cacheKey, cells)

  return <Raster key={key} {...box} cells={await cells} />
}

const pasted = atom({ plugin: 'inline-images', key: 'pasted' } as const, {})
// Keyed by the tool_use_id of a Read that returned an image.
const reads = atom({ plugin: 'inline-images', key: 'reads' } as const, {})

// A UserMessage row's requestId is its stored row's uuid with the last group zeroed.
const rowKey = (id: string) => id.slice(0, 23)


export const register: Register = (on, options) => {
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

    const using = await (converter ??= findConverter($))

    if (using === undefined) {
      return { deny: 'show_image needs sips (macOS), ImageMagick or ffmpeg to read images' }
    }

    const shown = await describe($, using, real, typeof input.columns === 'number' ? input.columns : undefined)

    return { result: JSON.stringify(shown) }
  }).catch(($, e, next) => ({ deny: `show_image failed: ${next.error.message ?? next.error.kind}` }))

  on('ui.render', { component: 'ToolResult', props: { tool: FULL_NAME } }, async ($, e, next) => {
    const shown = typeof e.props.output === 'string' ? (JSON.parse(e.props.output) as Shown) : undefined

    if (e.surface !== 'terminal' || e.props.isErrored || shown === undefined) {
      return next(e)
    }

    return (await picture($, $.ui.resolve(e), shown, (e.viewport?.columns ?? 80) - 6, e.requestId)) ?? next(e)
  })

  if (options.showReadImages !== false) {
    on('tool.call', { tool: 'Read' }, async ($, e, next) => {
      const ran = await next(e)

      if (ran.isError || ran.result?.type !== 'image') {
        return ran
      }

      const using = await (converter ??= findConverter($)).catch(() => undefined)
      const shown = using && (await describe($, using, e.file_path, READ_COLUMNS).catch(() => undefined))

      if (shown) {
        await update($, reads, all => ({ ...all, [e.tool_use_id]: shown })).catch(() => undefined)
      }

      return ran
    }).catch(($, e, next) => next(e))

    on('ui.render', { component: 'ToolUse', props: { tool: 'Read' } }, async ($, e, next) => {
      const shown = (await read($, reads))[e.props.tool_use_id]

      if (e.surface !== 'terminal' || shown === undefined) {
        return next(e)
      }

      const elements = $.ui.resolve(e)

      return (
        <elements.Box flexDirection="column">
          {await next(e)}
          {await picture($, elements, shown, (e.viewport?.columns ?? 80) - 6, e.requestId)}
        </elements.Box>
      )
    })

    // A folded group draws one count line and no rows, so its image Reads are drawn under that line.
    on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
      const all = await read($, reads)
      const shown = e.props.calls.flatMap(call => (call.tool_use_id === undefined ? [] : (all[call.tool_use_id] ?? [])))

      if (e.surface !== 'terminal' || e.props.isExpanded || shown.length === 0) {
        return next(e)
      }

      const elements = $.ui.resolve(e)
      const available = (e.viewport?.columns ?? 80) - 6
      const pictures = await Promise.all(shown.map((one, index) => picture($, elements, one, available, `${e.requestId}-${index}`)))

      return (
        <elements.Box flexDirection="column">
          {await next(e)}
          {pictures}
        </elements.Box>
      )
    })
  }

  if (options.showPastedImages === false) {
    return
  }

  // The prompt row holds the pasted image's bytes; the note row right after it names the file.
  let pastedRow: string | undefined

  on('session.append', { door: 'prompt' }, ($, e, next) => {
    pastedRow = e.message.content.some(block => block.type === 'image') ? e.uuid : undefined

    return next(e)
  })

  on('session.append', { door: 'note' }, async ($, e, next) => {
    const appended = await next(e)
    const files = e.message.content.flatMap(block =>
      block.type === 'text' ? [...String(block.text).matchAll(/\[Image: source: ([^\]]+)\]/g)].map(match => match[1] ?? '') : [],
    )
    const row = pastedRow

    if (row === undefined || files.length === 0) {
      return appended
    }

    pastedRow = undefined
    const using = await (converter ??= findConverter($)).catch(() => undefined)

    if (using !== undefined) {
      const shown = await Promise.all(files.map(file => describe($, using, file, PASTED_COLUMNS).catch(() => undefined)))
      await update($, pasted, all => ({ ...all, [rowKey(row)]: shown.filter(one => one !== undefined) })).catch(() => undefined)
    }

    return appended
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const shown = (await read($, pasted))[rowKey(e.requestId)]

    if (e.surface !== 'terminal' || shown === undefined) {
      return next(e)
    }

    const elements = $.ui.resolve(e)
    const available = (e.viewport?.columns ?? 80) - 6
    const pictures = await Promise.all(shown.map((one, index) => picture($, elements, one, available, `${e.requestId}-${index}`)))

    return (
      <elements.Box flexDirection="column">
        {await next(e)}
        {pictures}
      </elements.Box>
    )
  })
}
