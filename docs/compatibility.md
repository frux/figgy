# Compatibility contract

## Scope

Первый целевой профиль — read-only инструменты Figma Design для локального
экспортированного `.fig`. Remote-only операции, запись в Figma, FigJam, Slides,
Code Connect и поиск по облачным библиотекам не входят в начальный профиль:
локальный архив не содержит всех серверных данных, нужных этим операциям.

Профиль должен версионироваться датой/версией официального MCP. Ответы Figma
могут меняться независимо от формата `.fig`, поэтому «совместимость вообще»
без версии и golden corpus не является проверяемым обещанием.

## Current matrix

| Official tool | Status | Intended comparison |
| --- | --- | --- |
| `get_metadata` | Implemented, real-response calibrated; partial geometry/asset parity | Exact XML and MCP text envelope after CRLF normalization |
| `get_variable_defs` | Planned | Exact token names/values and content block shape |
| `get_screenshot` | Local PNG/SVG renderer implemented; official MCP envelope and visual parity not yet calibrated | MIME/dimensions plus pixel or perceptual diff |
| `get_design_context` | Planned | Structural/semantic comparison; declared normalization for ephemeral asset URLs |
| `download_assets` | Later | Exact original bytes where embedded; rendered-export parity by image diff |
| `get_motion_context` | Later, corpus-dependent | Structured tracks and generated code semantics |
| Code Connect tools | Out of local-only MVP | Requires mappings not guaranteed to exist in `.fig` |
| Write/remote tools | Out of scope | Requires Figma account/server state |

## Parity levels

### 1. Transport

- tool name and argument validation;
- successful and error MCP result shapes;
- order and types of `content` blocks;
- text/image MIME metadata.

### 2. Structure

- node IDs and type mapping;
- hierarchy and sibling order;
- coordinates and sizes;
- truncation/chunking behavior for large selections.

### 3. Semantics

- auto layout, constraints and sizing modes;
- text runs, typography and line metrics;
- fills, strokes, gradients, effects and blend modes;
- components, instances, overrides, styles and variables;
- asset identity and reuse.

### 4. Visual output

- viewport and scale;
- raster dimensions and alpha behavior;
- pixel diff for deterministic fixtures;
- explicit perceptual threshold only where font/platform rasterization makes
  exact pixels impossible.

## Golden rules

Each fixture must bind all of the following:

- SHA-256 of the exact `.fig` bytes;
- exact request arguments;
- raw MCP tool result, before an LLM summarizes it;
- capture date and, when observable, Figma MCP/server version;
- expected normalization rules.

Never silently update a golden when output changes. A golden update must say
whether the cause is a Figma MCP version change, a deliberate compatibility
profile change, or a figgy regression fix.

## Known uncertainties in the first slice

The local render path uses OpenPencil's FIG-to-SceneGraph conversion, SVG
export and CanvasKit headless rasterizer. It has been exercised against a real
private file without retaining the generated image, but that smoke test is not
a visual golden. Exact viewport selection, maximum dimensions, alpha behavior,
font availability and pixel output still need calibration against a raw
official `get_screenshot` response for the identical file revision.

Remote font providers are deliberately disabled. This is a privacy invariant:
font resolution must not transmit a private font family or text subset. The
tradeoff is deterministic bundled fallback rather than exact typography when
the requested face is unavailable locally.

The official documentation describes `get_metadata` as sparse XML with IDs,
names, types, positions and sizes, but does not publish a normative XML schema.
The current tag mapping, page-list response, attribute order, hidden marker and
two-block subtree envelope have been checked against a real official response.

Figma's read-only Plugin API property `isAsset` is itself heuristic: the exact
classifier is not serialized into `.fig`. The local implementation therefore
uses conservative small-vector rules and may leave some icon internals expanded
rather than risk hiding layout nodes.

For ordinary nodes, coordinates come directly from the decoded transform and
axis-aligned dimensions include that transform. Groups with computed bounds,
some vector geometry and instance-derived layout can still differ. A comparison
is meaningful only when the local export and cloud request name the same file
revision; otherwise a real design edit is indistinguishable from a serializer
error by looking at the two outputs alone.

The `.fig` node stream can also contain history-like repeated changes,
deletions, fractional sibling positions and newer property encodings. The
current model merges repeated node records in stream order and preserves first
appearance order. Real corpora will determine whether sibling position decoding
must replace that rule.
