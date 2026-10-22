import { expect, mock, test, type TestBody } from 'claude-code/testing'

const TOOL = 'mcp__inline-images__show_image'
const COPY = /^\/tmp\/claude-inline-images\.abc123\/\d+-\w+\.png$/
const SIPS = {
  exitCode: 0,
  stdout: '/x/cat.png\n  pixelWidth: 400\n  pixelHeight: 400\n',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
}
// Every command answers as sips does, except mktemp, which names the temp folder.
const MKTEMP = { ...SIPS, stdout: '/tmp/claude-inline-images.abc123\n' }
const answer = (argv: readonly string[]) => (argv[0] === 'mktemp' ? MKTEMP : SIPS)

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
  on('process.run', (_$, e) => ({ value: answer(e.argv) }))
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

  return { ui, cells: Array.from(new Uint32Array(Uint8Array.fromBase64(raster?.props.cells as string).buffer)) }
}

test('draws half blocks where the terminal has no kitty graphics', async ($, on) => {
  const blue = [255, 0, 0]
  const white = [255, 255, 255]
  const red = [0, 0, 255]
  const green = [0, 255, 0]
  const { cells } = await rasterCells($, on, bmp(2, 3, [[...blue, ...white], [...red, ...green]]))

  expect(cells).toEqual([0x2580, 0xff0000, 0x0000ff, 0x2580, 0x00ff00, 0xffffff])
})

test('leaves transparent pixels in the terminal background', async ($, on) => {
  const clear = [0, 0, 0, 0]
  const red = [0, 0, 255, 255]
  const { cells } = await rasterCells($, on, bmp(-2, 4, [[...clear, ...clear], [...red, ...clear]]))

  expect(cells).toEqual([0x2584, 0xff0000, 0x01000000, 0x20, 0x01000000, 0x01000000])
})

test('draws the copy button under half blocks', async ($, on) => {
  const { ui } = await rasterCells($, on, bmp(1, 3, [[0, 0, 0, 0, 0, 0]]))

  expect(await ui.find({ type: 'Button' })).toBeDefined()
})

test('shows a PNG as an Image sized to keep its aspect ratio', async ($, on) => {
  mock.env(on, { TERM_PROGRAM: 'ghostty' })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: '/x/cat.png' } }))
  on('process.run', (_$, e) => ({ value: answer(e.argv) }))

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

const drawnInOrca = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], env: Record<string, string>, size = 1) => {
  const commands: string[][] = []
  mock.env(on, { TERM_PROGRAM: 'Orca', ORCA_IMAGE_PROTOCOL: 'kitty', ...env })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('fs.stat', () => ({ value: { kind: 'file', size, mtimeMs: 0, isLink: false, realPath: '/x/cat.png' } }))
  on('fs.read', () => ({ value: { base64: bmp(2, 3, [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]]) } }))
  on('process.run', (_$, e) => {
    commands.push([...e.argv])

    return { value: answer(e.argv) }
  })

  const ran = await $.tool.call({ tool: TOOL, path: 'cat.png', columns: 2 })
  const ui = await $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 't1', tool: TOOL, output: ran.result, isErrored: false },
    viewport: { columns: 120, rows: 40 },
  })

  return { commands, image: await ui.find({ type: 'Image' }), raster: await ui.find({ type: 'Raster' }) }
}

test('shows an Image in Orca from a copy in a private temp folder when Claude Code is told to draw images', async ($, on) => {
  const { commands, image } = await drawnInOrca($, on, { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })
  const file = (image?.props.source as { file: string } | undefined)?.file

  expect(file).toMatch(COPY)
  expect(commands).toContainEqual(['mktemp', '-d', '/tmp/claude-inline-images.XXXXXX'])
  expect(commands).toContainEqual(['cp', '/x/cat.png', file])
})

test('makes the temp folder in $TMPDIR', async ($, on) => {
  const { commands } = await drawnInOrca($, on, { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1', TMPDIR: '/var/folders/ab/T/' })

  expect(commands).toContainEqual(['mktemp', '-d', '/var/folders/ab/T/claude-inline-images.XXXXXX'])
})

const HALF_BLOCK_CASES: [string, Record<string, string>, number][] = [
  ['without the flag', {}, 1],
  ['inside tmux', { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1', TMUX: '/tmp/tmux-501/default,1,0' }, 1],
  ['for a file over 2 MiB', { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' }, 3 * 1024 * 1024],
]

HALF_BLOCK_CASES.forEach(([name, env, size]) => {
  test(`draws half blocks in Orca ${name}`, async ($, on) => {
    const { image, raster } = await drawnInOrca($, on, env, size)

    expect(image).toBeUndefined()
    expect(raster).toBeDefined()
  })
})

test('converts a JPEG to PNG before drawing it', async ($, on) => {
  const commands: string[][] = []
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: '/x/cat.jpg' } }))
  on('process.run', (_$, e) => {
    commands.push([...e.argv])

    return { value: answer(e.argv) }
  })

  const ran = await $.tool.call({ tool: TOOL, path: 'cat.jpg' })
  expect(JSON.parse(ran.result as string).file).toMatch(COPY)
  expect(commands.some(argv => argv.includes('format') && argv.includes('/x/cat.jpg'))).toBe(true)
})

const buttons = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], exitCodes: Record<string, number>) => {
  const tools: string[] = []
  const files: (string | undefined)[] = []
  const toasts: string[] = []
  mock.env(on, { TERM_PROGRAM: 'ghostty' })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: '/x/cat.png' } }))
  on('process.run', (_$, e) => {
    const tool = ['osascript', 'open'].includes(e.argv[0] ?? '') ? e.argv[0] : /(wl-copy|xclip|xdg-open)/.exec(e.argv[2] ?? '')?.[1]

    if (tool === undefined) {
      return { value: answer(e.argv) }
    }

    tools.push(tool)
    files.push(e.argv.at(-1))

    return { value: { ...SIPS, exitCode: exitCodes[tool] ?? 0 } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  const ran = await $.tool.call({ tool: TOOL, path: 'cat.png' })
  const ui = await $.ui.mount({
    plugin: 'inline-images',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 't1',
    props: { tool_use_id: 't1', tool: TOOL, output: ran.result, isErrored: false },
    viewport: { columns: 120, rows: 40 },
  })

  return { ui, tools, files, toasts }
}

const CLIPBOARD_CASES: [string, Record<string, number>, string[], string][] = [
  ['osascript', {}, ['osascript'], 'Copied the image'],
  ['wl-copy after osascript fails', { osascript: 127 }, ['osascript', 'wl-copy'], 'Copied the image'],
  ['no tool', { osascript: 127, 'wl-copy': 1, xclip: 127 }, ['osascript', 'wl-copy', 'xclip'], 'Could not copy the image'],
]

CLIPBOARD_CASES.forEach(([name, exitCodes, tried, toast]) => {
  test(`copies the image from its copy button with the first clipboard tool that works: ${name}`, async ($, on) => {
    const { ui, tools, files, toasts } = await buttons($, on, exitCodes)
    await ui.press({ key: 'copy-t1' })

    expect(tools).toEqual(tried)
    expect(files).toEqual(tried.map(() => '/x/cat.png'))
    expect(toasts).toEqual([toast])
  })
})

const VIEWER_CASES: [string, Record<string, number>, string[], string[]][] = [
  ['xdg-open', {}, ['xdg-open'], []],
  ['open where xdg-open is missing', { 'xdg-open': 1 }, ['xdg-open', 'open'], []],
  ['no viewer', { 'xdg-open': 1, open: 1 }, ['xdg-open', 'open'], ['Could not open the image']],
]

VIEWER_CASES.forEach(([name, exitCodes, tried, toast]) => {
  test(`opens the image from its open button with the first viewer that works: ${name}`, async ($, on) => {
    const { ui, tools, files, toasts } = await buttons($, on, exitCodes)
    await ui.press({ key: 'open-t1' })

    expect(tools).toEqual(tried)
    expect(files).toEqual(tried.map(() => '/x/cat.png'))
    expect(toasts).toEqual(toast)
  })
})

test('leaves the copy button out when showCopyButton is off', { options: { showCopyButton: false } }, async ($, on) => {
  const { ui } = await buttons($, on, {})

  expect(await ui.find({ key: 'copy-t1' })).toBeUndefined()
  expect(await ui.find({ key: 'open-t1' })).toBeDefined()
})

test('leaves both buttons out when both are off', { options: { showCopyButton: false, showOpenButton: false } }, async ($, on) => {
  const { ui } = await buttons($, on, {})

  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(await ui.find({ type: 'Image' })).toBeDefined()
})

test('draws show_image at the defaultColumns width when Claude gives none', { options: { defaultColumns: 60 } }, async ($, on) => {
  const { ui } = await buttons($, on, {})

  expect((await ui.find({ type: 'Image' }))?.props).toEqual(expect.objectContaining({ columns: 60, rows: 30 }))
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

    return { value: e.argv[0] === 'mktemp' ? MKTEMP : { ...SIPS, exitCode: e.argv.at(-1) === 'command -v sips' ? 1 : 0, stdout: 'width=400 height=400' } }
  })

  const ran = await $.tool.call({ tool: TOOL, path: 'cat.jpg' })
  expect(JSON.parse(ran.result as string)).toEqual(expect.objectContaining({ width: 400, height: 400 }))
  expect(commands.filter(argv => !['sh', 'mktemp'].includes(argv[0] ?? '')).map(argv => argv[0])).toEqual(['magick', 'magick'])
})

const PROMPT_ROW = 'c68be964-85c5-4f99-896a-6223a68b0693'

const pastedImages = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  mock.env(on, { TERM_PROGRAM: 'ghostty' })
  on('process.run', (_$, e) => ({ value: answer(e.argv) }))
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

  return ui
}

test('draws a pasted image under its prompt, with a copy button', async ($, on) => {
  const ui = await pastedImages($, on)

  expect((await ui.find({ type: 'Image' }))?.props).toEqual(
    expect.objectContaining({ source: { file: '/x/paste.png', format: 'png' }, columns: 40, rows: 20 }),
  )
  expect(await ui.find({ type: 'Button' })).toBeDefined()
})

test('leaves pasted images out when showPastedImages is off', { options: { showPastedImages: false } }, async ($, on) => {
  expect(await (await pastedImages($, on)).find({ type: 'Image' })).toBeUndefined()
})

const READ_INPUT = { file_path: '/x/cat.png' }

const readImage = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) => {
  let toolUseId = ''
  mock.env(on, { TERM_PROGRAM: 'ghostty' })
  on('process.run', (_$, e) => ({ value: answer(e.argv) }))
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

test('draws an image Claude reads under the folded group of reads, with a copy button', async ($, on) => {
  const { mountGroup } = await readImage($, on)
  const ui = await mountGroup(false)

  expect((await ui.find({ type: 'Image' }))?.props).toEqual(
    expect.objectContaining({ source: { file: '/x/cat.png', format: 'png' }, columns: 60, rows: 30 }),
  )
  expect(await ui.find({ type: 'Button' })).toBeDefined()
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
