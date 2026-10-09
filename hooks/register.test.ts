import { expect, mock, test, type TestBody } from 'claude-code/testing'

const TOOL = 'mcp__inline-images__show_image'
const SIPS = {
  exitCode: 0,
  stdout: '/x/cat.png\n  pixelWidth: 400\n  pixelHeight: 400\n',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
}

// A BMP as sips writes it: `rows` holds each pixel row in file order, as BGR or BGRA bytes.
const bmp = (height: number, bytesPerPixel: number, rows: number[][]) => {
  const stride = Math.ceil((rows[0]?.length ?? 0) / 4) * 4
  const bytes = new Uint8Array(54 + stride * rows.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(10, 54, true)
  view.setInt32(22, height, true)
  view.setUint16(28, bytesPerPixel * 8, true)
  rows.forEach((row, y) => bytes.set(row, 54 + y * stride))

  return bytes.toBase64()
}

const rasterCells = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], pixels: string) => {
  mock.env(on, { TERM_PROGRAM: 'iTerm.app' })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: '/x/cat.png' } }))
  on('process.run', () => ({ value: SIPS }))
  on('fs.read', () => ({ value: { base64: pixels } }))

  const ran = await $.tool.call({ tool: TOOL, path: 'cat.png', columns: 2 })
  const ui = await $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 't1', tool: TOOL, output: ran.result, isErrored: false },
    viewport: { columns: 120, rows: 40 },
  })
  const raster = await ui.find({ type: 'Raster' })

  return Array.from(new Uint32Array(Uint8Array.fromBase64(raster?.props.cells as string).buffer))
}

test('draws half blocks where the terminal has no kitty graphics', async ($, on) => {
  const blue = [255, 0, 0]
  const white = [255, 255, 255]
  const red = [0, 0, 255]
  const green = [0, 255, 0]
  const cells = await rasterCells($, on, bmp(2, 3, [[...blue, ...white], [...red, ...green]]))

  expect(cells).toEqual([0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff])
})

test('leaves transparent pixels in the terminal background', async ($, on) => {
  const clear = [0, 0, 0, 0]
  const red = [0, 0, 255, 255]
  const cells = await rasterCells($, on, bmp(-2, 4, [[...clear, ...clear], [...red, ...clear]]))

  expect(cells).toEqual([0x2584, 0xff0000, 0x01000000, 0x20, 0x01000000, 0x01000000])
})

test('shows a PNG as an Image sized to keep its aspect ratio', async ($, on) => {
  mock.env(on, { TERM_PROGRAM: 'ghostty' })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: '/x/cat.png' } }))
  on('process.run', () => ({ value: SIPS }))

  const ran = await $.tool.call({ tool: TOOL, path: 'cat.png', columns: 40 })
  expect(JSON.parse(ran.result as string)).toEqual({ file: '/x/cat.png', width: 400, height: 400, columns: 40 })

  const ui = await $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 't1', tool: TOOL, output: ran.result, isErrored: false },
    viewport: { columns: 120, rows: 40 },
  })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toEqual(expect.objectContaining({ columns: 40, rows: 20 }))
})

test('converts a JPEG to PNG before drawing it', async ($, on) => {
  const commands: string[][] = []
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: '/x/cat.jpg' } }))
  on('process.run', (_$, e) => {
    commands.push([...e.argv])

    return { value: SIPS }
  })

  const ran = await $.tool.call({ tool: TOOL, path: 'cat.jpg' })
  expect(JSON.parse(ran.result as string).file).toMatch(/^\/tmp\/claude-inline-images\/\d+\.png$/)
  expect(commands.some(argv => argv.includes('format') && argv.includes('/x/cat.jpg'))).toBe(true)
})

test('refuses a missing file', async ($, on) => {
  on('fs.stat', () => ({ deny: 'ENOENT' }))

  const ran = await $.tool.call({ tool: TOOL, path: 'nope.png' })
  expect(ran.deny).toBe('nope.png does not exist')
})

test('falls back to ImageMagick where sips is missing', async ($, on) => {
  const commands: string[][] = []
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: '/x/cat.jpg' } }))
  on('process.run', (_$, e) => {
    commands.push([...e.argv])

    return { value: { ...SIPS, exitCode: e.argv.at(-1) === 'command -v sips' ? 1 : 0, stdout: 'width=400 height=400' } }
  })

  const ran = await $.tool.call({ tool: TOOL, path: 'cat.jpg' })
  expect(JSON.parse(ran.result as string)).toEqual(expect.objectContaining({ width: 400, height: 400 }))
  expect(commands.filter(argv => argv[0] !== 'sh' && argv[0] !== 'mkdir').map(argv => argv[0])).toEqual(['magick', 'magick'])
})
