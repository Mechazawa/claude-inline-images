import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Shown } from '../types'

const TOOL = 'show_image'
const FULL_NAME = 'mcp__inline-images__show_image'
// Orca reads kitty image files only from the project or the system temp folder, and only up to 2 MiB.
const ORCA_MAX_BYTES = 2 * 1024 * 1024
// Images are drawn at their own size (one image pixel per screen pixel) and only shrunk to fit, never enlarged. A `columns` of 0 in a Shown means "native size"; a positive one is an explicit width (show_image's columns).
const NATIVE = 0
// Used when the terminal's cell size in pixels cannot be measured.
const FALLBACK_CELL: Cell = { w: 16, h: 32 }
// An Image's rgba source holds at most 2 MiB decoded.
const MAX_RGBA_BYTES = 2 * 1024 * 1024
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
  const { exitCode, stdout, stderr } = await $.process.run(argv)

  if (exitCode !== 0) {
    throw new Error(`${argv[0]} failed: ${stderr.trim()}`)
  }

  return stdout
}

// mktemp makes the folder owner-only under a name nobody can take first, also in a shared /tmp.
let tempDir: Promise<string> | undefined

const makeTempDir = async ($: EngineInterface) => {
  const tmp = (await $.env.get('TMPDIR').catch(() => undefined)) || '/tmp'

  return (await run($, ['mktemp', '-d', `${tmp.replace(/\/+$/, '')}/claude-inline-images.XXXXXX`])).trim()
}

const inTempDir = async ($: EngineInterface, name: string) => {
  tempDir ??= makeTempDir($).catch(error => {
    tempDir = undefined
    throw error
  })

  return `${await tempDir}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${name}`
}

// tmux does not pass kitty graphics through, and Claude Code draws an Image in Orca only with this flag.
const drawsKittyInOrca = async ($: EngineInterface) =>
  (await $.env.get('ORCA_IMAGE_PROTOCOL')) === 'kitty' &&
  (await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')) === '1' &&
  (await $.env.get('TMUX')) === undefined

const pixelSize = async ($: EngineInterface, using: Converter, file: string) => {
  const stdout = await run($, using.size(file)).catch(() => '')

  return {
    width: Number(/width[:=] ?(\d+)/i.exec(stdout)?.[1] ?? 0),
    height: Number(/height[:=] ?(\d+)/i.exec(stdout)?.[1] ?? 0),
  }
}

// The terminal decodes PNG only, so every other format is converted first. Orca also gets a copy of a PNG, as the
// PNG can sit outside the folders it reads.
const asPng = async ($: EngineInterface, using: Converter, file: string) => {
  const isPng = /\.png$/i.test(file)

  if (isPng && !(await drawsKittyInOrca($))) {
    return file
  }

  const converted = await inTempDir($, '.png')
  await run($, isPng ? ['cp', file, converted] : using.png(file, converted))

  return converted
}

type Look = { isCopyable: boolean; isOpenable: boolean; isCollapsible: boolean; maxColumns: number; maxRows: number }

// The terminal's cell size in pixels. The mod API does not expose it, so it is read with TIOCGWINSZ from
// the tty of the nearest ancestor process that has one (Claude Code's own terminal); kitty, Ghostty, iTerm2 and
// WezTerm fill in the pixel fields.
type Cell = { w: number; h: number }

const CELL_SCRIPT = `
import fcntl, os, struct, subprocess, termios
pid = os.getppid()
for _ in range(12):
    out = subprocess.run(['ps', '-o', 'ppid=,tty=', '-p', str(pid)], capture_output=True, text=True).stdout.split()
    if len(out) < 2:
        break
    ppid, tty = out
    if tty not in ('?', '??', '-'):
        fd = os.open('/dev/' + tty, os.O_RDONLY | os.O_NOCTTY)
        r, c, x, y = struct.unpack('HHHH', fcntl.ioctl(fd, termios.TIOCGWINSZ, b'\\0' * 8))
        if r and c and x and y:
            print(round(x / c), round(y / r))
        break
    pid = int(ppid)
`

const measureCell = async ($: EngineInterface): Promise<Cell> => {
  const out = await run($, ['python3', '-I', '-c', CELL_SCRIPT]).catch(() => '')
  const [w, h] = out.trim().split(/\s+/).map(Number)

  return w && h && w > 0 && h > 0 ? { w, h } : FALLBACK_CELL
}

// Measured again when the width changes, which also covers a font size change in most cases.
let cellCache: { columns: number; cell: Promise<Cell> } | undefined

const cellSize = ($: EngineInterface, columns: number) => {
  if (cellCache?.columns !== columns) {
    cellCache = { columns, cell: measureCell($) }
  }

  return cellCache.cell
}

// The cells an image takes. At native size the box is rounded up to whole cells and `pad` is set, so the picture can
// be padded with transparency to fill it exactly instead of being stretched.
const cellBox = (shown: Shown, available: number, { maxColumns, maxRows }: Look, cell: Cell) => {
  const limitColumns = Math.max(1, Math.min(available, maxColumns, 255))
  const limitRows = Math.max(1, Math.min(maxRows, 255))
  const wanted = shown.columns > NATIVE ? (shown.columns * cell.w) / shown.width : 1
  const scale = Math.min(wanted, (limitColumns * cell.w) / shown.width, (limitRows * cell.h) / shown.height)

  if (shown.columns === NATIVE && scale >= 1) {
    return { columns: Math.ceil(shown.width / cell.w), rows: Math.ceil(shown.height / cell.h), pad: true }
  }

  return {
    columns: Math.min(limitColumns, Math.max(1, Math.round((shown.width * scale) / cell.w))),
    rows: Math.min(limitRows, Math.max(1, Math.round((shown.height * scale) / cell.h))),
    pad: false,
  }
}

// Reads a BMP the converter wrote into a pixel getter returning [r, g, b, a].
const bmpPixels = (base64: string) => {
  const view = new DataView(Uint8Array.fromBase64(base64).buffer)
  const offset = view.getUint32(10, true)
  const width = view.getInt32(18, true)
  const height = view.getInt32(22, true)
  const bytesPerPixel = view.getUint16(28, true) / 8
  const stride = Math.ceil((width * bytesPerPixel) / 4) * 4

  return (x: number, y: number) => {
    const at = offset + (height < 0 ? y : Math.abs(height) - 1 - y) * stride + x * bytesPerPixel

    return [view.getUint8(at + 2), view.getUint8(at + 1), view.getUint8(at), bytesPerPixel === 4 ? view.getUint8(at + 3) : 255]
  }
}

// The picture at its own pixels, top-left in a transparent canvas exactly the size of its cell box, so the terminal
// draws it 1:1 with no resampling. Undefined when it is too big for an rgba source.
const paddedRgba = async ($: EngineInterface, using: Converter, shown: Shown, box: { columns: number; rows: number }, cell: Cell) => {
  const width = box.columns * cell.w
  const height = box.rows * cell.h

  if (width > 2048 || height > 2048 || width * height * 4 > MAX_RGBA_BYTES) {
    return undefined
  }

  const bmp = await inTempDir($, '.bmp')
  await run($, using.bmp(shown.file, bmp, shown.width, shown.height))
  const { base64 } = await $.fs.read(bmp, { as: 'bytes' })
  await $.process.run(['rm', '-f', bmp])
  const pixel = bmpPixels(base64)
  const canvas = new Uint8Array(width * height * 4)

  for (let y = 0; y < shown.height; y++) {
    for (let x = 0; x < shown.width; x++) {
      canvas.set(pixel(x, y), (y * width + x) * 4)
    }
  }

  return { rgba: canvas.toBase64(), width, height }
}

const padded = new Map<string, Promise<{ rgba: string; width: number; height: number } | undefined>>()

// Terminals without kitty graphics get the picture as half blocks: each cell shows two stacked pixels.
const rasterCells = async ($: EngineInterface, using: Converter, file: string, columns: number, rows: number) => {
  const bmp = await inTempDir($, '.bmp')
  await run($, using.bmp(file, bmp, columns, rows * 2))
  const { base64 } = await $.fs.read(bmp, { as: 'bytes' })
  await $.process.run(['rm', '-f', bmp])
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

// wl-copy and xclip leave a child holding the clipboard, so its output goes to /dev/null, or the run waits for it.
const CLIPBOARDS = [
  ['osascript', '-e', 'on run argv', '-e', 'set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)', '-e', 'end run'],
  ['sh', '-c', 'wl-copy --type image/png < "$1" > /dev/null 2>&1', 'sh'],
  ['sh', '-c', 'xclip -selection clipboard -t image/png -i "$1" > /dev/null 2>&1', 'sh'],
]

// xdg-open goes first because Debian's kbd package installs openvt as `open`. It can wait until the viewer it starts
// is closed, so it runs in the background once it is found.
const VIEWERS = [['sh', '-c', 'command -v xdg-open > /dev/null && { xdg-open "$1" > /dev/null 2>&1 & }', 'sh'], ['open']]

const runFirst = async ($: EngineInterface, commands: string[][], file: string) => {
  for (const argv of commands) {
    if ((await $.process.run([...argv, file]).catch(() => undefined))?.exitCode === 0) {
      return true
    }
  }

  return false
}

const rasters = new Map<string, Promise<string>>()

const describe = async ($: EngineInterface, using: Converter, path: string, columns: number): Promise<Shown> => {
  const file = await asPng($, using, path)
  const size = await pixelSize($, using, file)

  if (size.width === 0 || size.height === 0) {
    throw new Error(`${path} is not an image ${using.binaries[0]} can read`)
  }

  return { file, ...size, columns }
}

const picture = async (
  $: EngineInterface,
  { Box, Button, Image, Raster }: Elements['terminal'],
  shown: Shown,
  available: number,
  key: string,
  look: Look,
) => {
  const cell = await cellSize($, available)
  const { pad, ...box } = cellBox(shown, available, look, cell)
  const isCollapsed = look.isCollapsible && (await read($, collapsed))[key] === true
  const copy = async () => $.ui.toast((await runFirst($, CLIPBOARDS, shown.file)) ? 'Copied the image' : 'Could not copy the image')
  const open = async () => (await runFirst($, VIEWERS, shown.file)) || $.ui.toast('Could not open the image')
  const toggle = () => update($, collapsed, all => ({ ...all, [key]: !isCollapsed }))
  const withButtons = (drawn?: JSX.Element) =>
    look.isCopyable || look.isOpenable || look.isCollapsible ? (
      <Box flexDirection="column">
        {drawn}
        <Box flexDirection="row" columnGap={1}>
          {look.isCollapsible && <Button key={`collapse-${key}`} label={isCollapsed ? 'expand' : 'collapse'} dimColor onPress={toggle} />}
          {look.isCopyable && <Button key={`copy-${key}`} label="copy" dimColor onPress={copy} />}
          {look.isOpenable && <Button key={`open-${key}`} label="open" dimColor onPress={open} />}
        </Box>
      </Box>
    ) : (
      drawn
    )

  if (isCollapsed) {
    return withButtons()
  }

  const isKitty =
    (await $.env.get('TERM_PROGRAM')) === 'ghostty' ||
    (await $.env.get('TERM')) === 'xterm-kitty' ||
    ((await drawsKittyInOrca($)) && ((await $.fs.stat(shown.file).catch(() => undefined))?.size ?? 0) <= ORCA_MAX_BYTES)

  const using = await (converter ??= findConverter($))

  if (isKitty) {
    const paddedKey = `${shown.file}:${box.columns}x${box.rows}:${cell.w}x${cell.h}`
    const exact =
      pad && using !== undefined
        ? (padded.get(paddedKey) ?? paddedRgba($, using, shown, box, cell).catch(() => undefined))
        : undefined

    if (exact !== undefined) {
      padded.set(paddedKey, exact)
    }

    const source = (await exact) ?? { file: shown.file, format: 'png' as const }

    return withButtons(<Image source={source} {...box} alt={shown.file} />)
  }

  if (using === undefined) {
    return undefined
  }

  const cacheKey = `${shown.file}:${box.columns}x${box.rows}`
  const cells = rasters.get(cacheKey) ?? rasterCells($, using, shown.file, box.columns, box.rows)
  rasters.set(cacheKey, cells)

  return withButtons(<Raster key={key} {...box} cells={await cells} />)
}

const pasted = atom({ plugin: 'inline-images', key: 'pasted' } as const, {})
// Keyed by the key of the drawn image.
const collapsed = atom({ plugin: 'inline-images', key: 'collapsed' } as const, {})
// Keyed by the tool_use_id of a Read that returned an image.
const reads = atom({ plugin: 'inline-images', key: 'reads' } as const, {})

// A UserMessage row's requestId is its stored row's uuid with the last group zeroed.
const rowKey = (id: string) => id.slice(0, 23)


export const register: Register = (on, options) => {
  const look = {
    isCopyable: options.showCopyButton !== false,
    isOpenable: options.showOpenButton !== false,
    isCollapsible: options.showCollapseButton !== false,
    maxColumns: typeof options.maxColumns === 'number' ? options.maxColumns : 255,
    maxRows: typeof options.maxRows === 'number' ? options.maxRows : 40,
  }
  const defaultColumns = typeof options.defaultColumns === 'number' && options.defaultColumns > 0 ? options.defaultColumns : NATIVE

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
          columns: {
            type: 'integer',
            minimum: 4,
            maximum: 255,
            description:
              defaultColumns === NATIVE
                ? "Width in terminal columns. Omit it to show the image at its own size (shrunk only if it doesn't fit)"
                : `Width in terminal columns, ${defaultColumns} by default`,
          },
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

    const shown = await describe($, using, real, typeof input.columns === 'number' ? input.columns : defaultColumns)

    return { result: JSON.stringify(shown) }
  }).catch(($, e, next) => ({ deny: `show_image failed: ${next.error.message ?? next.error.kind}` }))

  on('ui.render', { component: 'ToolResult', props: { tool: FULL_NAME } }, async ($, e, next) => {
    // A stored result can lack columns.
    const stored = typeof e.props.output === 'string' ? (JSON.parse(e.props.output) as Partial<Shown> & Omit<Shown, 'columns'>) : undefined
    const shown = stored && { columns: defaultColumns, ...stored }

    if (e.surface !== 'terminal' || e.props.isErrored || shown === undefined) {
      return next(e)
    }

    return (await picture($, $.ui.resolve(e), shown, (e.viewport?.columns ?? 80) - 6, e.requestId, look)) ?? next(e)
  })

  if (options.showReadImages !== false) {
    on('tool.call', { tool: 'Read' }, async ($, e, next) => {
      const ran = await next(e)

      if (ran.isError || ran.result?.type !== 'image') {
        return ran
      }

      const using = await (converter ??= findConverter($)).catch(() => undefined)
      const shown = using && (await describe($, using, e.file_path, NATIVE).catch(() => undefined))

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
          {await picture($, elements, shown, (e.viewport?.columns ?? 80) - 6, e.requestId, look)}
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
      const pictures = await Promise.all(shown.map((one, index) => picture($, elements, one, available, `${e.requestId}-${index}`, look)))

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
      const shown = await Promise.all(files.map(file => describe($, using, file, NATIVE).catch(() => undefined)))
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
    const pictures = await Promise.all(shown.map((one, index) => picture($, elements, one, available, `${e.requestId}-${index}`, look)))

    return (
      <elements.Box flexDirection="column">
        {await next(e)}
        {pictures}
      </elements.Box>
    )
  })
}
