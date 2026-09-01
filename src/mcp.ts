import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { getMetadataMcpResult } from "./compatibility/metadata.js";
import { describeError } from "./errors.js";
import { parseFigFile } from "./parser.js";
import { renderFigFile } from "./render.js";
import type { FigDocument } from "./types.js";

const SERVER_NAME = "figgy";
const SERVER_VERSION = "0.1.0";
const MAX_CACHED_DOCUMENTS = 16;

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function toolError(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: describeError(error) }],
  };
}

interface CachedDocument {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  document: FigDocument;
}

/** Create an MCP server that can read any local .fig path supplied by a tool call. */
export function createFiggyMcpServer(): McpServer {
  const metadataCache = new Map<string, CachedDocument>();

  const loadMetadata = async (filePath: string): Promise<FigDocument> => {
    const absoluteInput = resolve(filePath);
    const before = await stat(absoluteInput);
    const cached = metadataCache.get(absoluteInput);
    if (
      cached?.size === before.size &&
      cached.mtimeMs === before.mtimeMs &&
      cached.ctimeMs === before.ctimeMs
    ) {
      metadataCache.delete(absoluteInput);
      metadataCache.set(absoluteInput, cached);
      return cached.document;
    }

    const document = await parseFigFile(absoluteInput);
    const after = await stat(absoluteInput);
    metadataCache.set(absoluteInput, {
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
      document,
    });
    if (metadataCache.size > MAX_CACHED_DOCUMENTS) {
      const oldest = metadataCache.keys().next().value;
      if (oldest !== undefined) metadataCache.delete(oldest);
    }
    return document;
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "This server reads local Figma .fig files by path.",
        "Every tool call requires filePath; use an absolute path whenever possible.",
        "Call get_metadata without nodeId to list pages, then call it with the same filePath and a page or node id to inspect a subtree.",
        "Call get_screenshot with filePath to see the first page, a selected page, or a selected node.",
        "An optional fileKey is accepted only for compatibility with Figma MCP calls.",
      ].join(" "),
    },
  );

  server.registerTool(
    "get_metadata",
    {
      title: "Get Figma metadata",
      description:
        "Return sparse Figma MCP-style metadata from a local .fig file. Omit nodeId to list top-level pages.",
      inputSchema: z.object({
        filePath: z
          .string()
          .min(1)
          .describe("Local path to the .fig file. Absolute paths are recommended."),
        fileKey: z
          .string()
          .optional()
          .describe(
            "Accepted for Figma MCP compatibility and ignored; use filePath to select the local file.",
          ),
        nodeId: z
          .string()
          .optional()
          .describe("Figma node id in 12:34 or URL-style 12-34 form."),
        maxDepth: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Maximum number of descendant levels to include."),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ filePath, nodeId, maxDepth }): Promise<CallToolResult> => {
      try {
        const document = await loadMetadata(filePath);
        const result = getMetadataMcpResult(document, {
          includeImplementationInstruction: false,
          ...(nodeId !== undefined ? { nodeId } : {}),
          ...(maxDepth !== undefined ? { maxDepth } : {}),
        });
        return {
          content: result.content.map(({ text }) => ({ type: "text", text })),
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_screenshot",
    {
      title: "Get Figma screenshot",
      description:
        "Render a local .fig file to PNG and return it as an MCP image content block.",
      inputSchema: z
        .object({
          filePath: z
            .string()
            .min(1)
            .describe("Local path to the .fig file. Absolute paths are recommended."),
          fileKey: z
            .string()
            .optional()
            .describe(
              "Accepted for Figma MCP compatibility and ignored; use filePath to select the local file.",
            ),
          nodeId: z
            .string()
            .optional()
            .describe("Render one Figma node in 12:34 or 12-34 form."),
          page: z
            .string()
            .optional()
            .describe("Render a page selected by its exact name or id."),
          scale: z
            .number()
            .min(0.01)
            .max(8)
            .optional()
            .describe("PNG scale. Defaults to 1."),
          maxDimension: z
            .number()
            .int()
            .min(1)
            .max(8192)
            .optional()
            .describe("Maximum output edge length in pixels. Defaults to 4096."),
        })
        .refine(({ nodeId, page }) => !(nodeId && page), {
          message: "nodeId and page cannot be used together",
        }),
      annotations: readOnlyAnnotations,
    },
    async ({
      filePath,
      nodeId,
      page,
      scale,
      maxDimension,
    }): Promise<CallToolResult> => {
      const absoluteInput = resolve(filePath);
      const temporaryDirectory = await mkdtemp(join(tmpdir(), "figgy-mcp-render-"));
      const outputPath = join(temporaryDirectory, "screenshot.png");

      try {
        await renderFigFile(absoluteInput, {
          format: "png",
          outputPath,
          ...(nodeId !== undefined ? { nodeId } : {}),
          ...(page !== undefined ? { page } : {}),
          ...(scale !== undefined ? { scale } : {}),
          ...(maxDimension !== undefined ? { maxDimension } : {}),
        });
        const png = await readFile(outputPath);
        return {
          content: [
            {
              type: "image",
              data: png.toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    },
  );

  return server;
}

/** Run a Figgy MCP server over the current process's stdin and stdout. */
export async function runFiggyMcpServer(): Promise<void> {
  const server = createFiggyMcpServer();
  await server.connect(new StdioServerTransport());
}
