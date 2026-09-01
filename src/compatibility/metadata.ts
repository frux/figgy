import { FiggyError } from "../errors.js";
import { normalizeNodeId } from "../model.js";
import type { FigDocument, FigNode, McpTextResult } from "../types.js";
import { isLikelyMetadataAsset } from "./assets.js";

export const METADATA_IMPLEMENTATION_INSTRUCTION =
  "IMPORTANT: After you call this tool, you MUST call get_design_context if trying to implement the design, since this tool only returns metadata. If you do not call get_design_context, the agent will not be able to implement the design.";

export interface MetadataOptions {
  nodeId?: string;
  maxDepth?: number;
  includeImplementationInstruction?: boolean;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatNumber(value: number): string {
  if (Object.is(value, -0)) return "0";
  // Figma MCP serializes JavaScript numbers without display rounding. Keeping
  // their full representation matters: values decoded from transforms often
  // contain more precision than a human-facing geometry panel would show.
  return String(value);
}

function tagForNode(node: FigNode): string {
  return node.type.toLowerCase().replaceAll("_", "-");
}

function nodeAttributes(node: FigNode): string {
  const attributes: Array<[string, string]> = [
    ["id", node.id],
    ["name", node.name],
  ];
  if (node.x !== undefined) attributes.push(["x", formatNumber(node.x)]);
  if (node.y !== undefined) attributes.push(["y", formatNumber(node.y)]);
  if (node.width !== undefined) {
    attributes.push(["width", formatNumber(node.width)]);
  }
  if (node.height !== undefined) {
    attributes.push(["height", formatNumber(node.height)]);
  }
  if (node.visible === false) attributes.push(["hidden", "true"]);
  return attributes
    .map(([name, value]) => `${name}="${escapeXml(value)}"`)
    .join(" ");
}

function renderNode(
  document: FigDocument,
  node: FigNode,
  depth: number,
  maxDepth: number,
): string[] {
  const indent = "  ".repeat(depth);
  const tag = tagForNode(node);
  const open = `<${tag} ${nodeAttributes(node)}`;
  if (
    node.children.length === 0 ||
    depth >= maxDepth ||
    isLikelyMetadataAsset(document, node)
  ) {
    return [`${indent}${open} />`];
  }

  return [
    `${indent}${open}>`,
    ...node.children.flatMap((child) =>
      renderNode(document, child, depth + 1, maxDepth),
    ),
    `${indent}</${tag}>`,
  ];
}

function pageList(document: FigDocument): string {
  return [
    "No nodeId was provided. Listing the top-level pages of the document. Call get_metadata again with one of the page ids below (or any node id underneath) to get the XML metadata for that subtree.",
    "",
    "Top-level pages of the document:",
    ...document.pages.map((page) => `- ${page.id}: ${page.name}`),
  ].join("\n");
}

export function getMetadataText(
  document: FigDocument,
  options: MetadataOptions = {},
): string {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(maxDepth) && maxDepth !== Number.POSITIVE_INFINITY) {
    throw new FiggyError(
      "maxDepth must be a non-negative integer",
      "FIG_METADATA_DEPTH_INVALID",
    );
  }
  if (maxDepth < 0) {
    throw new FiggyError(
      "maxDepth must be a non-negative integer",
      "FIG_METADATA_DEPTH_INVALID",
    );
  }

  let body: string;
  if (options.nodeId === undefined) {
    // The official page-list response is navigation guidance only and does not
    // append the implementation reminder used for XML subtree responses.
    return pageList(document);
  } else {
    const nodeId = normalizeNodeId(options.nodeId);
    const node = document.nodes.get(nodeId);
    if (!node) {
      const pages = document.pages
        .map((page) => `${page.id} (${page.name})`)
        .join(", ");
      const suffix = pages ? ` Available pages: ${pages}.` : "";
      throw new FiggyError(
        `Unknown Figma node ${nodeId}.${suffix}`,
        "FIG_NODE_NOT_FOUND",
      );
    }
    body = renderNode(document, node, 0, maxDepth).join("\n");
  }

  if (options.includeImplementationInstruction === false) return body;
  return `${body}\n\n${METADATA_IMPLEMENTATION_INSTRUCTION}`;
}

export function getMetadataMcpResult(
  document: FigDocument,
  options: MetadataOptions = {},
): McpTextResult {
  if (options.nodeId !== undefined) {
    const xml = getMetadataText(document, {
      ...options,
      includeImplementationInstruction: false,
    });
    if (options.includeImplementationInstruction !== false) {
      return {
        content: [
          { type: "text", text: xml },
          { type: "text", text: METADATA_IMPLEMENTATION_INSTRUCTION },
        ],
      };
    }
    return { content: [{ type: "text", text: xml }] };
  }

  return {
    content: [{ type: "text", text: getMetadataText(document, options) }],
  };
}
