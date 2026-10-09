# claude-inline-images

A Claude Code mod that shows images inline in your terminal.

It gives Claude a `show_image` tool. When you ask Claude to show you an image, the tool draws the file in the
transcript. The image does not go into Claude's context. Claude uses `Read` when it must look at the image itself.

![Claude Code in Ghostty, showing a JPEG inline with show_image](docs/screenshot.png)

Claude Code does not draw real images in iTerm2, so there the mod uses a fallback: colored half-block characters,
two pixels per cell.

![Claude Code in iTerm2, showing the same image as half blocks](docs/screenshot-iterm2.png)

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
- A terminal with 24-bit color. [Ghostty](https://ghostty.org) and [kitty](https://sw.kovidgoyal.net/kitty/) show the
  image at full resolution with the kitty graphics protocol. Other terminals, such as iTerm2, and all terminals inside
  tmux show the image as colored half-block characters, two pixels per cell.
- macOS. The mod reads the image size with `sips`. It also uses `sips` to convert JPEG, GIF, WebP, HEIC and TIFF files
  to PNG for the kitty graphics protocol, and to BMP for the half blocks. Converted files go to
  `/tmp/claude-inline-images`.

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
