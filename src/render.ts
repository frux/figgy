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
import { fontManager } from "@open-pencil/core/text";

import { FiggyError, describeError } from "./errors.js";
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
