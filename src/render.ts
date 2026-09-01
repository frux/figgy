import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

import {
  parseFigFile as parseOpenPencilFigFile,
} from "@open-pencil/core/io/formats/fig";
import {
  computeContentBounds,
  headlessRenderNodes,
} from "@open-pencil/core/io/formats/raster";
import { renderNodesToSVG } from "@open-pencil/core/io/formats/svg";
import { computeAllLayouts } from "@open-pencil/core/layout";
import {
  fontFaceDemand,
  fontManager,
  fontResolver,
  weightToStyle,
} from "@open-pencil/core/text";
import {
  alignGeometryWindingRules,
  convertFigmaTransformProps,
  resolveGeometryPaths,
} from "@open-pencil/fig/node-change";
import {
  TransformMatrix,
  getNodeLocalMatrix,
  getWorldMatrix,
  type Mat3,
  type SceneNode,
} from "@open-pencil/scene-graph";

import { FiggyError, describeError } from "./errors.js";
import { createSystemFontLoader } from "./fonts.js";
import { normalizeNodeId } from "./model.js";

export type RenderFormat = "png" | "svg";

export interface RenderOptions {
  format?: RenderFormat;
  nodeId?: string;
  page?: string;
  scale?: number;
  maxDimension?: number;
  outputPath?: string;
  force?: boolean;
}

export interface RenderResult {
  outputPath: string;
  format: RenderFormat;
  mimeType: string;
  byteLength: number;
  requestedScale?: number;
  effectiveScale?: number;
  width?: number;
  height?: number;
}

const DEFAULT_MAX_DIMENSION = 4096;
const MAX_MAX_DIMENSION = 8192;
const MAX_RASTER_PIXELS = 4096 * 4096;
const MIN_SCALE = 0.01;
const MAX_SCALE = 8;
const FIGMA_DERIVED_GLYPH_FAMILY = "__figgy_figma_derived_glyphs__";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function systemErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function assertScale(value: number): void {
  if (!Number.isFinite(value) || value < MIN_SCALE || value > MAX_SCALE) {
    throw new FiggyError(
      `Render scale must be between ${MIN_SCALE} and ${MAX_SCALE}, received ${value}`,
      "FIG_RENDER_SCALE_INVALID",
    );
  }
}

function assertMaxDimension(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_MAX_DIMENSION) {
    throw new FiggyError(
      `Maximum render dimension must be an integer between 1 and ${MAX_MAX_DIMENSION}, received ${value}`,
      "FIG_RENDER_MAX_DIMENSION_INVALID",
    );
  }
}

function inferredFormat(outputPath: string | undefined): RenderFormat | undefined {
  if (!outputPath) return undefined;
  const extension = extname(outputPath).toLowerCase();
  if (extension === ".png") return "png";
  if (extension === ".svg") return "svg";
  return undefined;
}

function resolveFormat(options: RenderOptions): RenderFormat {
  const fromOutput = inferredFormat(options.outputPath);
  if (options.outputPath && !fromOutput && options.format === undefined) {
    throw new FiggyError(
      "Cannot infer render format from output path; use a .png/.svg extension or --format",
      "FIG_RENDER_FORMAT_UNKNOWN",
    );
  }
  if (options.format && fromOutput && options.format !== fromOutput) {
    throw new FiggyError(
      `Output extension .${fromOutput} conflicts with --format ${options.format}`,
      "FIG_RENDER_FORMAT_CONFLICT",
    );
  }
  return options.format ?? fromOutput ?? "png";
}

function defaultOutputPath(
  inputPath: string,
  format: RenderFormat,
  nodeId: string | undefined,
): string {
  const extension = extname(inputPath);
  const stem = extension.length > 0 ? inputPath.slice(0, -extension.length) : inputPath;
  const suffix = nodeId ? `.${normalizeNodeId(nodeId).replace(":", "-")}` : "";
  return `${stem}${suffix}.${format}`;
}

function normalizedNodeSelector(nodeId: string | undefined): string | undefined {
  return nodeId === undefined ? undefined : normalizeNodeId(nodeId);
}

function optionalNormalizedId(value: string): string | undefined {
  return /^(?:-?\d+)(?::|-)(?:-?\d+)$/.test(value.trim())
    ? normalizeNodeId(value)
    : undefined;
}

function resolveSourceNode(
  graph: Awaited<ReturnType<typeof parseOpenPencilFigFile>>,
  sourceId: string,
) {
  const sourceMatches = [...graph.getAllNodes()].filter(
    (node) => node.source.id === sourceId,
  );
  if (sourceMatches.length > 1) {
    throw new FiggyError(
      `Render node ${sourceId} maps to multiple scene nodes`,
      "FIG_RENDER_NODE_AMBIGUOUS",
    );
  }
  return sourceMatches[0] ?? graph.getNode(sourceId);
}

function containingPageId(
  graph: Awaited<ReturnType<typeof parseOpenPencilFigFile>>,
  nodeId: string,
): string | undefined {
  const visited = new Set<string>();
  let current = graph.getNode(nodeId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.type === "CANVAS") return current.id;
    current = current.parentId ? graph.getNode(current.parentId) : undefined;
  }
  return undefined;
}

function rasterGeometry(
  contentWidth: number,
  contentHeight: number,
  requestedScale: number,
  maxDimension: number,
): { scale: number; width: number; height: number } {
  const dimensionScale = Math.min(
    maxDimension / contentWidth,
    maxDimension / contentHeight,
  );
  const pixelScale = Math.sqrt(
    MAX_RASTER_PIXELS / (contentWidth * contentHeight),
  );
  const scale = Math.min(requestedScale, dimensionScale, pixelScale);
  const width = Math.max(1, Math.ceil(contentWidth * scale));
  const height = Math.max(1, Math.ceil(contentHeight * scale));
  return { scale, width, height };
}

function preferFigmaDerivedText(
  graph: Awaited<ReturnType<typeof parseOpenPencilFigFile>>,
): void {
  for (const node of graph.getAllNodes()) {
    if (node.type !== "TEXT" || !node.figmaDerivedTextGlyphs?.length) continue;

    // The FIG payload stores the exact glyph outlines and positions used by
    // Figma. OpenPencil normally uses those only after a font lookup fails.
    // Mark a private synthetic family as exhausted so the headless renderer
    // selects the embedded outlines immediately instead of reshaping the text
    // with a possibly different locally-installed font version.
    node.fontFamily = FIGMA_DERIVED_GLYPH_FAMILY;
    // Headless PNG export installs a CanvasKit text measurer and recomputes
    // auto-layout once more. Re-measuring an imported FIG text node can change
    // its stored height and move later siblings even though both its glyphs and
    // layout size are already authoritative.
    node.textAutoResize = "NONE";
    const style = weightToStyle(node.fontWeight, node.italic);
    fontResolver.exhaust(
      fontFaceDemand(FIGMA_DERIVED_GLYPH_FAMILY, style, node.text),
    );
  }
}

function figmaGuid(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const sessionID = value.sessionID;
  const localID = value.localID;
  return Number.isInteger(sessionID) && Number.isInteger(localID)
    ? `${String(sessionID)}:${String(localID)}`
    : undefined;
}

function embeddedFigmaBlob(value: unknown): Uint8Array | undefined {
  if (!isRecord(value)) return undefined;
  const wrapped = value.__openPencilFigmaBlob;
  if (wrapped instanceof Uint8Array) return wrapped;
  if (!isRecord(wrapped)) return undefined;
  const entries = Object.entries(wrapped)
    .filter(([key, byte]) => /^\d+$/.test(key) && Number.isInteger(byte))
    .sort(([left], [right]) => Number(left) - Number(right));
  return entries.length > 0
    ? new Uint8Array(entries.map(([, byte]) => Number(byte)))
    : undefined;
}

function derivedTextGlyphs(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.glyphs)) return [];
  return value.glyphs.flatMap((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate.position)) return [];
    const commandsBlob = embeddedFigmaBlob(candidate.commandsBlob);
    const x = candidate.position.x;
    const y = candidate.position.y;
    const fontSize = candidate.fontSize;
    if (
      !commandsBlob ||
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof fontSize !== "number"
    ) {
      return [];
    }
    return [{ commandsBlob, x, y, fontSize }];
  });
}

function derivedGeometryPaths(value: unknown) {
  if (!Array.isArray(value)) return [];
  const blobs: Uint8Array[] = [];
  const paths: Array<{
    windingRule?: string;
    commandsBlob: number;
    styleID?: number;
  }> = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const commandsBlob = embeddedFigmaBlob(candidate.commandsBlob);
    if (!commandsBlob) continue;
    const blobIndex = blobs.push(commandsBlob) - 1;
    paths.push({
      commandsBlob: blobIndex,
      ...(typeof candidate.windingRule === "string"
        ? { windingRule: candidate.windingRule }
        : {}),
      ...(typeof candidate.styleID === "number"
        ? { styleID: candidate.styleID }
        : {}),
    });
  }
  return resolveGeometryPaths(paths, blobs);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function figmaLinearTransform(node: SceneNode): Mat3 | undefined {
  const raw = node.source.fig.rawTransform;
  if (!isRecord(raw)) return undefined;
  const m00 = numberField(raw.m00);
  const m01 = numberField(raw.m01);
  const m10 = numberField(raw.m10);
  const m11 = numberField(raw.m11);
  if (
    m00 === undefined ||
    m01 === undefined ||
    m10 === undefined ||
    m11 === undefined
  ) {
    return undefined;
  }
  const current = getNodeLocalMatrix(node);
  return [m00, m01, current[2]!, m10, m11, current[5]!, 0, 0, 1];
}

function matrixDiffers(left: Mat3, right: Mat3, epsilon = 0.000001): boolean {
  return left.some((value, index) => Math.abs(value - right[index]!) > epsilon);
}

function transformCommandsBlob(blob: Uint8Array, matrix: Mat3): Uint8Array {
  const output = new Uint8Array(blob);
  const view = new DataView(
    output.buffer,
    output.byteOffset,
    output.byteLength,
  );
  let offset = 0;
  const transformPoints = (count: number): boolean => {
    const byteLength = count * 8;
    if (offset + byteLength > output.byteLength) return false;
    for (let index = 0; index < count; index += 1) {
      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      view.setFloat32(
        offset,
        matrix[0]! * x + matrix[1]! * y + matrix[2]!,
        true,
      );
      view.setFloat32(
        offset + 4,
        matrix[3]! * x + matrix[4]! * y + matrix[5]!,
        true,
      );
      offset += 8;
    }
    return true;
  };

  while (offset < output.byteLength) {
    const command = output[offset];
    offset += 1;
    if (command === undefined) return blob;
    if (command === 0) continue;
    const pointCount = command === 1 || command === 2 ? 1 : command === 3 ? 2 : 3;
    if (command < 1 || command > 4 || !transformPoints(pointCount)) return blob;
  }
  return output;
}

function restoreFigmaAffineTransforms(
  graph: Awaited<ReturnType<typeof parseOpenPencilFigFile>>,
): void {
  const exactWorldByNode = new Map<string, Mat3>();
  const exactWorld = (node: SceneNode): Mat3 => {
    const cached = exactWorldByNode.get(node.id);
    if (cached) return cached;
    const currentLocal = getNodeLocalMatrix(node);
    const rawLocal = figmaLinearTransform(node);
    const local = rawLocal && matrixDiffers(rawLocal, currentLocal)
      ? rawLocal
      : currentLocal;
    const parent = node.parentId ? graph.getNode(node.parentId) : undefined;
    const world = parent
      ? TransformMatrix.multiply(exactWorld(parent), local)
      : local;
    exactWorldByNode.set(node.id, world);
    return world;
  };

  for (const node of graph.getAllNodes()) {
    if (
      node.fillGeometry.length === 0 &&
      node.strokeGeometry.length === 0 &&
      !node.figmaDerivedTextGlyphs?.length
    ) {
      continue;
    }
    const inverseCurrent = TransformMatrix.invert(getWorldMatrix(node, graph));
    if (!inverseCurrent) continue;
    const correction = TransformMatrix.multiply(inverseCurrent, exactWorld(node));
    if (!matrixDiffers(correction, TransformMatrix.identity())) continue;

    node.fillGeometry = node.fillGeometry.map((geometry) => ({
      ...geometry,
      commandsBlob: transformCommandsBlob(geometry.commandsBlob, correction),
    }));
    node.strokeGeometry = node.strokeGeometry.map((geometry) => ({
      ...geometry,
      commandsBlob: transformCommandsBlob(geometry.commandsBlob, correction),
    }));
    if (node.figmaDerivedTextGlyphs?.length) {
      const glyphCorrection: Mat3 = [
        correction[0]!,
        -correction[1]!,
        0,
        -correction[3]!,
        correction[4]!,
        0,
        0,
        0,
        1,
      ];
      node.figmaDerivedTextGlyphs = node.figmaDerivedTextGlyphs.map((glyph) => {
        const position = TransformMatrix.mapPoint(correction, {
          x: glyph.x,
          y: glyph.y,
        });
        return {
          ...glyph,
          x: position.x,
          y: position.y,
          commandsBlob: transformCommandsBlob(
            glyph.commandsBlob,
            glyphCorrection,
          ),
        };
      });
    }
  }
}

function preferImportedBooleanGeometry(
  graph: Awaited<ReturnType<typeof parseOpenPencilFigFile>>,
): void {
  for (const node of graph.getAllNodes()) {
    if (node.type !== "BOOLEAN_OPERATION" || node.fillGeometry.length === 0) {
      continue;
    }

    // OpenPencil normally recomputes boolean operations from their children.
    // Its child-path transform supports translation, rotation, and flips, but
    // not the general affine matrices stored by Figma. Keeping the imported
    // contour avoids losing shear a second time; boolean nodes never render
    // their children as independent scene content.
    node.childIds = [];
  }
}

function findOverrideDescendant(
  graph: Awaited<ReturnType<typeof parseOpenPencilFigFile>>,
  rootId: string,
  overrideKey: string,
) {
  const root = graph.getNode(rootId);
  const queue = root ? [...root.childIds] : [];
  for (let index = 0; index < queue.length; index += 1) {
    const node = graph.getNode(queue[index]!);
    if (!node) continue;
    if (node.overrideKey === overrideKey) return node;
    queue.push(...node.childIds);
  }
  return undefined;
}

function resolveOverridePath(
  graph: Awaited<ReturnType<typeof parseOpenPencilFigFile>>,
  instanceId: string,
  rawPath: unknown,
) {
  if (!Array.isArray(rawPath)) return undefined;
  const path = rawPath.map(figmaGuid);
  if (path.some((value) => value === undefined)) return undefined;

  let target = graph.getNode(instanceId);
  for (const overrideKey of path) {
    if (!target) return undefined;
    target = findOverrideDescendant(graph, target.id, overrideKey as string);
  }
  return target;
}

function restoreInheritedSymbolVisibility(
  graph: Awaited<ReturnType<typeof parseOpenPencilFigFile>>,
): void {
  const directOverrides = new Map<string, boolean>();
  for (const instance of graph.getAllNodes()) {
    if (instance.type !== "INSTANCE") continue;
    for (const override of instance.source.fig.symbolOverrides) {
      if (!isRecord(override) || typeof override.visible !== "boolean") continue;
      const guidPath = isRecord(override.guidPath)
        ? override.guidPath.guids
        : undefined;
      const target = resolveOverridePath(graph, instance.id, guidPath);
      if (target) directOverrides.set(target.id, override.visible);
    }
  }

  if (directOverrides.size === 0) return;
  const clonesByComponent = new Map<string, string[]>();
  for (const node of graph.getAllNodes()) {
    if (!node.componentId) continue;
    const clones = clonesByComponent.get(node.componentId) ?? [];
    clones.push(node.id);
    clonesByComponent.set(node.componentId, clones);
  }

  for (const [targetId, visible] of directOverrides) {
    const target = graph.getNode(targetId);
    if (target) target.visible = visible;
    const queue = [...(clonesByComponent.get(targetId) ?? [])];
    for (let index = 0; index < queue.length; index += 1) {
      const cloneId = queue[index]!;
      if (directOverrides.has(cloneId)) continue;
      const clone = graph.getNode(cloneId);
      if (!clone) continue;
      clone.visible = visible;
      queue.push(...(clonesByComponent.get(cloneId) ?? []));
    }
  }
}

function restoreDerivedInstanceData(
  graph: Awaited<ReturnType<typeof parseOpenPencilFigFile>>,
): void {
  for (const instance of graph.getAllNodes()) {
    if (instance.type !== "INSTANCE") continue;
    const entries = instance.source.fig.derivedSymbolData;
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (!isRecord(entry) || !isRecord(entry.guidPath)) continue;
      const glyphs = derivedTextGlyphs(entry.derivedTextData);
      const fillGeometry = derivedGeometryPaths(entry.fillGeometry);
      const strokeGeometry = derivedGeometryPaths(entry.strokeGeometry);
      const target = resolveOverridePath(
        graph,
        instance.id,
        entry.guidPath.guids,
      );
      if (!target) continue;

      const derivedLayout = { ...(target.figmaDerivedLayout ?? {}) };
      if (isRecord(entry.size)) {
        if (typeof entry.size.x === "number") {
          target.width = entry.size.x;
          derivedLayout.width = entry.size.x;
        }
        if (typeof entry.size.y === "number") {
          target.height = entry.size.y;
          derivedLayout.height = entry.size.y;
        }
      }
      if (isRecord(entry.transform)) {
        const transformed = convertFigmaTransformProps({
          transform: entry.transform,
          size: isRecord(entry.size)
            ? entry.size
            : { x: target.width, y: target.height },
        } as unknown as Parameters<typeof convertFigmaTransformProps>[0]);
        target.x = transformed.x;
        target.y = transformed.y;
        target.rotation = transformed.rotation;
        target.flipX = transformed.flipX;
        target.flipY = transformed.flipY;
        derivedLayout.x = transformed.x;
        derivedLayout.y = transformed.y;
      } else if (glyphs.length > 0) {
        const uniformScaleFactor = instance.source.fig.uniformScaleFactor;
        if (
          typeof uniformScaleFactor === "number" &&
          uniformScaleFactor > 0 &&
          uniformScaleFactor !== 1
        ) {
          target.x *= uniformScaleFactor;
          target.y *= uniformScaleFactor;
          derivedLayout.x = target.x;
          derivedLayout.y = target.y;
        }
      }
      if (fillGeometry.length > 0) {
        target.fillGeometry = alignGeometryWindingRules(
          fillGeometry,
          target.vectorNetwork,
        );
      }
      if (strokeGeometry.length > 0) target.strokeGeometry = strokeGeometry;
      if (glyphs.length > 0 && target.type === "TEXT") {
        target.figmaDerivedTextGlyphs = glyphs;
      }
      if (Object.keys(derivedLayout).length > 0) {
        target.figmaDerivedLayout = derivedLayout;
      }
    }
  }
}

// Kept out of the package root API. These hooks let synthetic fixtures cover
// the binary geometry and renderer-compatibility rules without checking in a
// real Figma document.
export const renderCompatibilityInternals = Object.freeze({
  preferFigmaDerivedText,
  preferImportedBooleanGeometry,
  transformCommandsBlob,
});

/**
 * Render a local .fig file without enabling OpenPencil's remote font sources.
 * Embedded images remain in memory and are never fetched from or uploaded to a
 * remote service.
 */
export async function renderFigFile(
  inputPath: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  if (options.nodeId !== undefined && options.page !== undefined) {
    throw new FiggyError(
      "Render accepts either a node or a page, not both",
      "FIG_RENDER_TARGET_CONFLICT",
    );
  }

  const format = resolveFormat(options);
  const nodeId = normalizedNodeSelector(options.nodeId);
  const requestedScale = options.scale ?? 1;
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  assertScale(requestedScale);
  assertMaxDimension(maxDimension);
  if (format === "svg" && options.scale !== undefined) {
    throw new FiggyError(
      "--scale is only available for PNG rendering",
      "FIG_RENDER_OPTION_UNSUPPORTED",
    );
  }
  if (format === "svg" && options.maxDimension !== undefined) {
    throw new FiggyError(
      "--max-dimension is only available for PNG rendering",
      "FIG_RENDER_OPTION_UNSUPPORTED",
    );
  }

  const absoluteInput = resolve(inputPath);
  let bytes: Buffer;
  try {
    bytes = await readFile(absoluteInput);
  } catch (error) {
    throw new FiggyError(
      `Cannot read ${absoluteInput}: ${describeError(error)}`,
      "FIG_RENDER_FILE_UNREADABLE",
      { cause: error },
    );
  }

  let graph: Awaited<ReturnType<typeof parseOpenPencilFigFile>>;
  try {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    graph = await parseOpenPencilFigFile(buffer, { populate: "all" });
    computeAllLayouts(graph);
  } catch (error) {
    throw new FiggyError(
      `Cannot build the render scene: ${describeError(error)}`,
      "FIG_RENDER_SCENE_FAILED",
      { cause: error },
    );
  }

  // Figma export omits editor-only layout grids. OpenPencil falls back to the
  // original .fig field when the modeled array is empty, so keep a disabled
  // sentinel in the ephemeral graph to prevent that fallback from drawing the
  // editor overlay.
  for (const node of graph.getAllNodes()) {
    node.layoutGrids = [{ visible: false }];
  }
  restoreInheritedSymbolVisibility(graph);
  restoreDerivedInstanceData(graph);
  restoreFigmaAffineTransforms(graph);
  preferImportedBooleanGeometry(graph);
  preferFigmaDerivedText(graph);

  const pages = graph.getPages();
  const pageSourceId = options.page
    ? optionalNormalizedId(options.page)
    : undefined;
  const selectedPage = options.page
    ? pages.find(
        (page) =>
          page.id === options.page ||
          page.name === options.page ||
          (pageSourceId !== undefined && page.source.id === pageSourceId),
      )
    : pages[0];

  let renderNodeIds: string[];
  let renderPageId: string;
  let trimTransparent = false;
  if (nodeId) {
    const renderNode = resolveSourceNode(graph, nodeId);
    if (!renderNode) {
      throw new FiggyError(
        `Render node ${nodeId} was not found`,
        "FIG_RENDER_NODE_NOT_FOUND",
      );
    }
    const pageId = containingPageId(graph, renderNode.id);
    if (!pageId) {
      throw new FiggyError(
        `Render node ${nodeId} is not attached to a page`,
        "FIG_RENDER_NODE_DETACHED",
      );
    }
    renderPageId = pageId;
    renderNodeIds = [renderNode.id];
  } else {
    if (!selectedPage) {
      throw new FiggyError(
        options.page
          ? `Render page ${JSON.stringify(options.page)} was not found`
          : "The document has no renderable pages",
        "FIG_RENDER_PAGE_NOT_FOUND",
      );
    }
    renderPageId = selectedPage.id;
    renderNodeIds = selectedPage.childIds;
    trimTransparent = true;
  }

  const bounds = computeContentBounds(graph, renderNodeIds);
  if (!bounds) {
    throw new FiggyError(
      "The selected target has no visible renderable content",
      "FIG_RENDER_EMPTY",
    );
  }
  const contentWidth = bounds.maxX - bounds.minX;
  const contentHeight = bounds.maxY - bounds.minY;
  if (contentWidth <= 0 || contentHeight <= 0) {
    throw new FiggyError(
      "The selected target has zero-sized renderable content",
      "FIG_RENDER_EMPTY",
    );
  }

  // OpenPencil enables Google/Fontsource providers by default. Disable all of
  // them: a local NDA design must never leak font names or text subsets in a
  // font request. Missing fonts render through bundled fallbacks instead.
  fontManager.setOnlineFontProviders({
    google: false,
    fontsource: false,
    bunny: false,
    fontshare: false,
  });
  fontManager.setHostFontLoader(createSystemFontLoader());

  const geometry =
    format === "png"
      ? rasterGeometry(
          contentWidth,
          contentHeight,
          requestedScale,
          maxDimension,
        )
      : undefined;

  let rendered: string | Uint8Array;
  try {
    const data =
      format === "png"
        ? await headlessRenderNodes(graph, renderPageId, renderNodeIds, {
            format: "PNG",
            scale: geometry?.scale ?? requestedScale,
            trimTransparent,
          })
        : renderNodesToSVG(graph, renderPageId, renderNodeIds, {
            xmlDeclaration: true,
          });
    if (data === null) {
      throw new Error("The renderer produced no output");
    }
    rendered = data;
  } catch (error) {
    throw new FiggyError(
      `Cannot render the selected target: ${describeError(error)}`,
      "FIG_RENDER_FAILED",
      { cause: error },
    );
  }

  const outputPath = resolve(
    options.outputPath ?? defaultOutputPath(absoluteInput, format, nodeId),
  );
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, rendered, {
      flag: options.force === true ? "w" : "wx",
    });
  } catch (error) {
    if (systemErrorCode(error) === "EEXIST") {
      throw new FiggyError(
        `Refusing to overwrite ${outputPath}; pass --force to replace it`,
        "FIG_RENDER_OUTPUT_EXISTS",
        { cause: error },
      );
    }
    throw new FiggyError(
      `Cannot write ${outputPath}: ${describeError(error)}`,
      "FIG_RENDER_OUTPUT_UNWRITABLE",
      { cause: error },
    );
  }

  const byteLength =
    typeof rendered === "string"
      ? Buffer.byteLength(rendered)
      : rendered.byteLength;
  return {
    outputPath,
    format,
    mimeType: format === "png" ? "image/png" : "image/svg+xml",
    byteLength,
    ...(geometry
      ? {
          requestedScale,
          effectiveScale: geometry.scale,
          width: geometry.width,
          height: geometry.height,
        }
      : {}),
  };
}
