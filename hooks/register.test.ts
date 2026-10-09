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

const PROMPT_ROW = 'c68be964-85c5-4f99-896a-6223a68b0693'

const pastedImages = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  mock.env(on, { TERM_PROGRAM: 'ghostty' })
  on('process.run', () => ({ value: SIPS }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))

  await $.session.append({
    uuid: PROMPT_ROW,
    door: 'prompt',
    origin: { kind: 'composer' },
    message: {
      type: 'user',
      role: 'user',
      content: [
        { type: 'text', text: '[Image #1]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
      ],
    },
  })
  await $.session.append({
    uuid: '2a56bb66-ec63-4d7c-ba83-97f09b5fdf7e',
    door: 'note',
    origin: { kind: 'composer' },
    message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: '[Image: source: /x/paste.png]' }] },
  })

  const ui = await $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'c68be964-85c5-4f99-896a-000000000000',
    props: { text: '[Image #1]', origin: { kind: 'composer' }, isExpanded: false },
    viewport: { columns: 120, rows: 40 },
  })

  return ui.find({ type: 'Image' })
}

test('draws a pasted image under its prompt', async ($, on) => {
  const image = await pastedImages($, on)

  expect(image?.props).toEqual(expect.objectContaining({ source: { file: '/x/paste.png', format: 'png' }, columns: 40, rows: 20 }))
})

test('leaves pasted images out when showPastedImages is off', { options: { showPastedImages: false } }, async ($, on) => {
  expect(await pastedImages($, on)).toBeUndefined()
})

const READ_INPUT = { file_path: '/x/cat.png' }

const readImage = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  let toolUseId = ''
  mock.env(on, { TERM_PROGRAM: 'ghostty' })
  on('process.run', () => ({ value: SIPS }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('tool.call', { tool: 'Read' }, (_$, e) => {
    toolUseId = e.tool_use_id

    return { result: { type: 'image', file: { base64: '', type: 'image/png', originalSize: 1 } } }
  })

  await $.tool.call({ tool: 'Read', ...READ_INPUT })

  const call = { tool_use_id: toolUseId, tool: 'Read', input: READ_INPUT, isRunning: false, isErrored: false, isInterrupted: false }
  const mountGroup = (isExpanded: boolean) =>
    $.ui.mount({
      plugin: 'inline-images',
      surface: 'terminal',
      component: 'ToolGroup',
      requestId: 'group-1',
      props: { calls: [call], isActive: false, isExpanded },
      viewport: { columns: 120, rows: 40 },
    })
  const mountRow = () =>
    $.ui.mount({
      plugin: 'inline-images',
      surface: 'terminal',
      component: 'ToolUse',
      requestId: toolUseId,
      props: call,
      viewport: { columns: 120, rows: 40 },
    })

  return { mountGroup, mountRow }
}

test('draws an image Claude reads under the folded group of reads', async ($, on) => {
  const { mountGroup } = await readImage($, on)
  const image = await (await mountGroup(false)).find({ type: 'Image' })

  expect(image?.props).toEqual(expect.objectContaining({ source: { file: '/x/cat.png', format: 'png' }, columns: 60, rows: 30 }))
})

test('draws it under the Read row, and not again under the group, once the group is expanded', async ($, on) => {
  const { mountGroup, mountRow } = await readImage($, on)

  expect(await (await mountGroup(true)).find({ type: 'Image' })).toBeUndefined()
  expect(await (await mountRow()).find({ type: 'Image' })).toBeDefined()
})

test('leaves images Claude reads out when showReadImages is off', { options: { showReadImages: false } }, async ($, on) => {
  const { mountGroup } = await readImage($, on)

  expect(await (await mountGroup(false)).find({ type: 'Image' })).toBeUndefined()
})
