# claude-inline-images

A Claude Code mod that shows images inline in your terminal.

It gives Claude a `show_image` tool. When you ask Claude to show you an image, the tool draws the file in the
transcript with the kitty graphics protocol. The image does not go into Claude's context. Claude uses `Read`
when it must look at the image itself.

## Install

At the prompt of a Claude Code session in the terminal, type:

```
/plugin install inline-images --marketplace Mechazawa/claude-inline-images
```

Answer `y` to add the marketplace, then select a scope. The tool is available from the next prompt.

## Usage

Ask Claude to show you a file:

```
show me ~/Downloads/screenshot.jpg
```

Claude calls `show_image` with these inputs:

| Input | Description |
| --- | --- |
| `path` | Absolute or working-directory-relative path of the image |
| `columns` | Width in terminal columns, 80 by default |

The image keeps its aspect ratio. It is never wider than the transcript and never taller than 40 rows.

## Requirements

- Claude Code 2.1.275 or later.
- A terminal with the kitty graphics protocol: [Ghostty](https://ghostty.org) or [kitty](https://sw.kovidgoyal.net/kitty/).
  Other terminals show the file path in place of the image. tmux does not pass the images through.
- macOS. The mod reads the image size with `sips`. The terminal decodes PNG only, so the mod also uses `sips` to
  convert JPEG, GIF, WebP, HEIC and TIFF files. Converted files go to `/tmp/claude-inline-images`.

## Development

Run Claude Code with the mod loaded from this folder:

```
claude --plugin-dir .
```

Check and test it:

```
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE)
