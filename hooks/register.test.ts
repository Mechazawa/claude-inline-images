import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__inline-images__show_image'
const SIPS = {
  exitCode: 0,
  stdout: '/x/cat.png\n  pixelWidth: 400\n  pixelHeight: 400\n',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
}

test('shows a PNG as an Image sized to keep its aspect ratio', async ($, on) => {
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
