# figgy

`figgy` is a local MCP server for exported Figma files (`.fig`). Its primary
use is to replace the official Figma MCP server in supported read-only
workflows while keeping the design source on the local filesystem and avoiding
the need for a Figma account or API token.

It can also be used as a standalone CLI for inspecting metadata, rendering
pages and nodes, and comparing responses with saved Figma MCP results.

The current MCP profile exposes two Figma-compatible tools:

| Tool | Result |
| --- | --- |
| `get_metadata` | Top-level page navigation or sparse XML for a node subtree |
| `get_screenshot` | A locally rendered PNG in an MCP image content block |

Metadata and rendering have been calibrated against the official MCP output,
but `figgy` is not yet a complete replacement for every Figma MCP tool. See
[`docs/compatibility.md`](docs/compatibility.md) for the current compatibility
profile.

## Install

Node.js 20 or newer and npm are required.

```bash
git clone https://github.com/frux/figgy.git
cd figgy
npm install
npm run build
npm link
```

`npm link` makes the `figgy` executable available to local MCP clients. You can
skip it and use the absolute path to `dist/cli.js` instead.

## Connect Figgy to an MCP agent

Start one MCP server for all local `.fig` files the agent can access:

```bash
figgy mcp
```

The command uses standard input and standard output for the MCP protocol. It
normally should be started by the agent, not run interactively. A silent
process is expected until an MCP client connects and sends a request.

### Codex

Register the server with Codex after building and linking the project:

```bash
codex mcp add figgy -- figgy mcp
codex mcp get figgy
```

Start a new Codex session, or reload the client, so the newly registered tools
are discovered. The agent can now call `get_metadata` and `get_screenshot`
without a Figma URL, file key, account, or token.

If an older file-bound Figgy command is already registered under this name,
replace it once:

```bash
codex mcp remove figgy
codex mcp add figgy -- figgy mcp
```

If you did not run `npm link`, register the built entry point directly:

```bash
codex mcp add figgy -- \
  node /absolute/path/to/figgy/dist/cli.js \
  mcp
```

### Other MCP clients

For clients configured with an `mcpServers` JSON object, use:

```json
{
  "mcpServers": {
    "figgy": {
      "command": "figgy",
      "args": ["mcp"]
    }
  }
}
```

The exact configuration-file location and reload flow depend on the client.
Prefer an absolute executable path when the client does not inherit your shell
environment.

### How an agent should use the server

1. Call `get_metadata` with the absolute `filePath` and no `nodeId` to list the
   document pages.
2. Call `get_metadata` again with the same `filePath` and a page or node ID to
   inspect that subtree.
3. Call `get_screenshot` with `filePath` and the same `nodeId` when visual
   context is needed.

For example, the conceptual MCP arguments are:

```json
{
  "filePath": "/absolute/path/to/layout.fig",
  "nodeId": "12:34"
}
```

`filePath` selects the file independently for every call, so one registered
Figgy server can work with any number of local designs. Relative paths are
resolved from the MCP server process's working directory; absolute paths are
recommended.

`fileKey` is not required. It is accepted and ignored when an agent sends
arguments shaped like an official Figma MCP call. Node IDs can use either
canonical `12:34` notation or the URL-style `12-34` notation.

The required local `filePath` in place of the official server's cloud
`fileKey` is the deliberate input-contract difference between Figgy and Figma
MCP. Tool names and result content blocks retain the compatible shape.

`get_metadata` supports these arguments:

| Argument | Type | Description |
| --- | --- | --- |
| `filePath` | string | Required local path to the `.fig` file |
| `nodeId` | string | Page or node to inspect; omit it to list pages |
| `maxDepth` | integer | Optional descendant-depth limit |
| `fileKey` | string | Optional compatibility argument; ignored |

`get_screenshot` supports:

| Argument | Type | Description |
| --- | --- | --- |
| `filePath` | string | Required local path to the `.fig` file |
| `nodeId` | string | Render one node |
| `page` | string | Render a page by exact name or ID |
| `scale` | number | PNG scale from 0.01 through 8; default `1` |
| `maxDimension` | integer | Maximum edge length; default `4096`, maximum `8192` |
| `fileKey` | string | Optional compatibility argument; ignored |

`nodeId` and `page` cannot be used together. With neither selector,
`get_screenshot` renders the first page from `filePath`.

Decoded metadata is cached for up to 16 recently used paths and automatically
refreshed when a file's size or filesystem timestamps change. Changing files
or replacing a `.fig` therefore does not require registering or restarting the
MCP server.

## Standalone CLI

The existing CLI workflow remains available:

```bash
figgy inspect ./layout.fig
figgy get-metadata ./layout.fig
figgy get-metadata ./layout.fig --node 12:34 --depth 3
figgy render ./layout.fig --node 12:34 --output ./frame.png
figgy verify ./layout.fig ./goldens/layout.frame.get_metadata.json
```

During development, run the CLI without building first:

```bash
npm run dev -- inspect /path/to/layout.fig
npm run dev -- get-metadata /path/to/layout.fig --node 12-34 --format mcp
npm run dev -- render /path/to/layout.fig --output /tmp/layout.png
```

### Metadata

Without `--node`, `get-metadata` returns the top-level page list. Use
`--depth 0` to return only the selected node without expanding descendants.
`--format mcp` wraps the text in an MCP-compatible `content` envelope.

```bash
figgy get-metadata ./layout.fig
figgy get-metadata ./layout.fig --node 12:34 --depth 3
figgy get-metadata ./layout.fig --node 12-34 --format mcp
```

### Local rendering

Without `--node` or `--page`, `render` exports the first page. Select a node by
Figma GUID or a page by its exact name or ID:

```bash
figgy render ./layout.fig --output ./page.png
figgy render ./layout.fig --page "Main" --format svg --output ./page.svg
figgy render ./layout.fig --node 12-34 --scale 2 --output ./card@2x.png
```

PNG and SVG are supported. If `--format` is omitted, it is inferred from the
output extension. PNG output is limited by default to a 4096 px side and a
total 4096×4096 pixel budget. The command reports the effective scale, width,
and height as JSON. Existing files are not overwritten unless `--force` is
provided.

Rendering uses OpenPencil's headless engine to reconstruct the SceneGraph,
embedded images, vector geometry, paints, masks, effects, and text. PNG output
is rasterized locally with CanvasKit. Before export, `figgy` restores:

- exact glyph outlines and positions stored in the FIG payload;
- derived geometry and layout data for overridden instances;
- inherited visibility for nested component variants;
- full affine transforms, including shear;
- imported boolean contours that would otherwise be recomputed from child
  shapes.

Editor layout grids are excluded from exported images. Online font providers
are disabled; fonts are resolved only from standard system directories and
paths listed in `FIGGY_FONT_DIRS`. When a `.fig` file contains Figma-derived
glyph outlines, they take priority over reshaping text with a locally installed
font.

### Pixel comparison

Use the render comparison helper to measure visual parity:

```bash
npm run compare:renders -- ./reference.png ./local.png ./diff.png
```

It verifies image dimensions and reports exact-pixel ratio, MAE, RMSE, PSNR,
and percentages above several pixel-delta thresholds. If a third path is
provided, it writes a red difference heatmap.

### Golden verification

Save the raw result of the official MCP `get_metadata` tool in the format
described in [`goldens/README.md`](goldens/README.md), then run:

```bash
figgy verify ./layout.fig ./goldens/layout.frame.get_metadata.json
```

Exit codes are `0` for a match, `1` for invalid input, and `2` for a completed
comparison that found a difference. Line endings are normalized, while
meaningful fields remain untouched.

## Supported FIG data

- modern `.fig` ZIP archives, including ZIP data descriptors;
- legacy files that start directly with `fig-kiwi`;
- each file's embedded Kiwi schema instead of one hard-coded format version;
- deflate and zstd payloads;
- node-tree reconstruction and lookup by Figma GUID;
- filtering of internal-only canvases and conservative vector-asset collapsing;
- axis-aligned node dimensions derived from local transform matrices.

## Compatibility model

Compatibility is tested at four independent levels:

1. **Transport:** MCP tool names, arguments, content blocks, and errors.
2. **Structure:** nodes, order, properties, and response shape.
3. **Semantics:** layout, typography, paints, variables, and components.
4. **Visual output:** image dimensions and pixel or perceptual differences.

Byte-for-byte equality is not meaningful for every official tool. For example,
temporary asset URLs and generated code can be nondeterministic. Normalization
should be introduced only when a captured result demonstrates that a field is
nondeterministic.

## Architecture

```text
agent ↔ stdio MCP ↔ mcp.ts
                       ├─ get_metadata
                       │    └─ archive → Kiwi decoder → indexed node tree → XML
                       └─ get_screenshot
                            └─ OpenPencil FIG import → SceneGraph → CanvasKit PNG

standalone CLI ────────┴─ the same metadata and rendering functions
```

The MCP transport, document model, and renderer remain separate, so the CLI
and server use the same implementation rather than maintaining parallel paths.

## Development

```bash
npm run check
npm run test:coverage
```

Tests generate synthetic `.fig` files with `@open-pencil/kiwi` and
`@open-pencil/core`. The MCP integration test launches `figgy mcp` through the
official Model Context Protocol stdio client, lists its tools, requests
metadata, and validates a returned PNG. No external design files or installed
Figma application are required by the test suite.

The `.fig` format is closed and not officially documented. This implementation
reads the Kiwi schema embedded in each file and builds on the open
[Kiwi](https://github.com/evanw/kiwi) format. The official Figma MCP tools and
their intended use are documented in the
[Figma developer documentation](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/).
