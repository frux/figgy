# figgy

`figgy` is a local CLI for reading and rendering exported Figma files
(`.fig`) and reproducing responses from read-only tools exposed by the
official Figma MCP server.

The project is at an early stage. It already provides an end-to-end
`get_metadata` pipeline:

```text
.fig container → embedded Kiwi schema → node tree → sparse XML → MCP content[]
```

The response format has been calibrated against the official MCP output.
Computed geometry for complex groups and Figma's internal `isAsset` heuristic
still provide partial rather than complete parity.

## What works

- modern `.fig` ZIP archives, including ZIP data descriptors;
- legacy files that start directly with `fig-kiwi`;
- embedded Kiwi schemas, so each file is decoded with its own schema instead of
  relying on one hard-coded format version;
- deflate and zstd payloads;
- node-tree reconstruction and lookup by Figma GUID
  (`sessionID:localID`);
- filtering of internal-only canvases and conservative collapsing of vector
  assets;
- axis-aligned node dimensions derived from local transform matrices;
- `inspect` for quick file diagnostics;
- `get-metadata` / `get_metadata` with plain-text or MCP-envelope output;
- local rendering of pages or individual nodes to PNG and SVG;
- `verify` for comparison with a saved response from the official Figma MCP
  server.

## Installation

Node.js 20 or newer and npm are required.

```bash
npm install
npm run build
node dist/cli.js --help
```

During development, run the CLI without building it first:

```bash
npm run dev -- inspect /path/to/layout.fig
npm run dev -- get-metadata /path/to/layout.fig
npm run dev -- get-metadata /path/to/layout.fig --node 12:34
npm run dev -- get-metadata /path/to/layout.fig --node 12-34 --format mcp
npm run dev -- render /path/to/layout.fig --output /tmp/layout.png
```

After a global installation or `npm link`, the command is available as
`figgy`:

```bash
figgy inspect ./layout.fig
figgy get-metadata ./layout.fig --node 12:34 --depth 3
figgy render ./layout.fig --node 12:34 --output ./frame.png
```

## Metadata

Without `--node`, `get-metadata` returns the top-level page list. The
`--node` option accepts both the canonical `12:34` form and the URL-style
`12-34` form. Use `--depth 0` to return only the selected node without
expanding its descendants.

```bash
figgy get-metadata ./layout.fig
figgy get-metadata ./layout.fig --node 12:34 --depth 3
figgy get-metadata ./layout.fig --node 12-34 --format mcp
```

## Local rendering

Without `--node` or `--page`, `render` exports the first page. Select a
node by Figma GUID or a page by its exact name or ID:

```bash
figgy render ./layout.fig --output ./page.png
figgy render ./layout.fig --page "Main" --format svg --output ./page.svg
figgy render ./layout.fig --node 12-34 --scale 2 --output ./card@2x.png
```

PNG and SVG are currently supported. If `--format` is omitted, the format is
inferred from the `--output` extension. PNG output is limited by default to a
4096 px side and a total 4096×4096 pixel budget. The command returns the
effective scale, width, and height in its JSON result. Use
`--max-dimension` to set a smaller side limit. Existing files are not
overwritten unless `--force` is provided.

Rendering uses OpenPencil's headless engine to reconstruct the SceneGraph,
embedded images, vector geometry, paints, masks, effects, and text. PNG output
is rasterized locally with CanvasKit.

Before export, `figgy` restores:

- exact glyph outlines and positions stored in the FIG payload;
- derived geometry and layout data for overridden instances;
- inherited visibility for nested component variants;
- full affine transforms, including shear;
- imported boolean contours that would otherwise be recomputed from child
  shapes.

Editor layout grids are excluded from exported images.

All online font providers are disabled. Fonts are resolved only from standard
system directories and paths listed in `FIGGY_FONT_DIRS`. When a `.fig`
file contains Figma-derived glyph outlines, they take priority over reshaping
the text with a locally installed font.

### Pixel comparison

Use the render comparison helper to measure visual parity:

```bash
npm run compare:renders -- ./reference.png ./local.png ./diff.png
```

The command verifies image dimensions and reports the exact-pixel ratio, MAE,
RMSE, PSNR, and the percentage of pixels above delta thresholds 4, 8, 16, and
32. If a third path is provided, it also writes a red difference heatmap.

## Compatibility verification

Save the raw result of the official MCP `get_metadata` tool as a golden file
using the format described in [`goldens/README.md`](goldens/README.md), then
run:

```bash
figgy verify ./layout.fig ./goldens/layout.frame.get_metadata.json
```

Exit codes:

- `0` — the local MCP envelope matches the golden file;
- `1` — the input file, arguments, or golden file are invalid;
- `2` — comparison completed and found a difference.

`verify` reports the path to the first difference, for example
`$.content[0].text`. CRLF and LF line endings are normalized, but meaningful
fields are left untouched so compatibility problems remain visible.

## What “the same response” means

Compatibility is divided into four independently testable levels:

1. **Transport parity** — matching MCP content-block types and errors.
2. **Structural parity** — matching nodes, order, properties, and response
   shape.
3. **Semantic parity** — equivalent layout, typography, paints, variables, and
   component semantics.
4. **Visual parity** — screenshots and assets compared pixel-by-pixel or
   against an explicit threshold.

Byte-for-byte equality is not always meaningful. For example, the official
`get_design_context` tool can generate React and Tailwind output by default,
while asset URLs may be temporary. Such fields should be normalized only when
a golden result demonstrates that they are nondeterministic. See
[`docs/compatibility.md`](docs/compatibility.md) for the complete
compatibility matrix.

## Architecture

```text
.fig
  └─ archive.ts       ZIP/legacy container, lazy archive-entry reads
      └─ decoder.ts   fig-kiwi framing, deflate/zstd, embedded schema
          └─ model.ts node changes → indexed tree
              ├─ compatibility/metadata.ts
              ├─ inspect.ts
              └─ golden.ts

.fig
  └─ render.ts        OpenPencil FIG import → SceneGraph
      ├─ SVG export   local vector output
      └─ CanvasKit    local PNG rasterization
```

The transport layer is intentionally separated from the document model. Once
the contracts stabilize, a stdio MCP server can be added on top of the same
functions without duplicating the decoder or compatibility logic.

## Development

```bash
npm run check
npm run test:coverage
```

Tests generate a synthetic `.fig` file with the current
`@open-pencil/kiwi` package. A separate integration fixture creates a ZIP
archive with data descriptors, so the test suite does not depend on external
design files or an installed Figma application.

The `.fig` format is closed and not officially documented. This
implementation reads the Kiwi schema embedded in each file and builds on the
open [Kiwi](https://github.com/evanw/kiwi) format. The current Figma MCP tools
and their intended use are documented in the
[official Figma documentation](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/).
