import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { getMetadataMcpResult } from "./compatibility/metadata.js";
import { describeError } from "./errors.js";
import { parseFigFile } from "./parser.js";
import { renderFigFile } from "./render.js";

const SERVER_NAME = "figgy";
const SERVER_VERSION = "0.1.0";

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

/**
 * Create an MCP server bound to one local .fig file.
 *
 * The metadata document is decoded once when the server starts. Screenshot
 * rendering intentionally reopens the file so the renderer can use its own
 * complete SceneGraph import pipeline.
 */
export async function createFiggyMcpServer(inputPath: string): Promise<McpServer> {
  const absoluteInput = resolve(inputPath);
  const document = await parseFigFile(absoluteInput);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "This server is bound to one local Figma .fig file.",
        "Call get_metadata without nodeId to list pages, then call it with a page or node id to inspect a subtree.",
        "Call get_screenshot to see the first page, a selected page, or a selected node.",
        "No fileKey is required; an optional fileKey is accepted only for compatibility with Figma MCP calls.",
      ].join(" "),
    },
  );

  server.registerTool(
    "get_metadata",
    {
      title: "Get Figma metadata",
      description:
        "Return sparse Figma MCP-style metadata from the local .fig file. Omit nodeId to list top-level pages.",
      inputSchema: z.object({
        fileKey: z
          .string()
          .optional()
          .describe(
            "Accepted for Figma MCP compatibility and ignored because this server is already bound to one local file.",
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
    async ({ nodeId, maxDepth }): Promise<CallToolResult> => {
      try {
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
        "Render the local .fig file to PNG and return it as an MCP image content block.",
      inputSchema: z
        .object({
          fileKey: z
            .string()
            .optional()
            .describe(
              "Accepted for Figma MCP compatibility and ignored because this server is already bound to one local file.",
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
    async ({ nodeId, page, scale, maxDimension }): Promise<CallToolResult> => {
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
export async function runFiggyMcpServer(inputPath: string): Promise<void> {
  const server = await createFiggyMcpServer(inputPath);
  await server.connect(new StdioServerTransport());
}
