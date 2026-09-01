import type { FigDocument, FigNode, RawRecord } from "../types.js";

// Figma's Plugin API exposes a read-only `isAsset` property, but its exact
// implementation is intentionally heuristic and is not stored in a .fig file.
// These conservative rules mirror the documented high-level behavior for
// small vector graphics while preferring false negatives over hiding real UI.
const MAX_VECTOR_ASSET_DIMENSION = 256;
const COMPACT_ICON_DIMENSION = 48;
const LARGE_DESIGN_CONTEXT_DIMENSION = 120;

const VECTOR_GRAPHIC_TYPES = new Set([
  "BOOLEAN_OPERATION",
  "ELLIPSE",
  "FRAME",
  "INSTANCE",
  "LINE",
  "ROUNDED_RECTANGLE",
  "VECTOR",
]);

function isRecord(value: unknown): value is RawRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rawSize(node: FigNode): { width: number; height: number } | undefined {
  const size = isRecord(node.raw.size) ? node.raw.size : undefined;
  const width = typeof size?.x === "number" ? size.x : node.width;
  const height = typeof size?.y === "number" ? size.y : node.height;
  if (
    width === undefined ||
    height === undefined ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }
  return { width: Math.abs(width), height: Math.abs(height) };
}

function hasOnlyVectorGraphicDescendants(node: FigNode): boolean {
  const pending = [...node.children];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current.id)) continue;
    visited.add(current.id);
    if (!VECTOR_GRAPHIC_TYPES.has(current.type)) return false;
    pending.push(...current.children);
  }
  return true;
}

function effectCount(node: FigNode): number {
  return Array.isArray(node.raw.effects) ? node.raw.effects.length : 0;
}

/**
 * Best-effort local equivalent of Figma Plugin API's private `node.isAsset`
 * heuristic, used by the official metadata serializer to stop at icon roots.
 */
export function isLikelyMetadataAsset(
  document: FigDocument,
  node: FigNode,
): boolean {
  if (
    node.children.length === 0 ||
    (node.type !== "FRAME" && node.type !== "BOOLEAN_OPERATION")
  ) {
    return false;
  }

  const size = rawSize(node);
  if (!size) return false;
  const maxDimension = Math.max(size.width, size.height);
  if (maxDimension > MAX_VECTOR_ASSET_DIMENSION) return false;
  if (!hasOnlyVectorGraphicDescendants(node)) return false;

  // A boolean-operation container is itself a vector composition. Figma
  // treats compact compositions as one exportable graphic.
  if (node.type === "BOOLEAN_OPERATION") return true;

  // Frames are more ambiguous: a small frame can also be a real layout. Requiring
  // a direct vector child and modest effect complexity keeps the rule conservative.
  const hasDirectVector = node.children.some((child) => child.type === "VECTOR");
  if (!hasDirectVector || effectCount(node) > 2) return false;

  const parent = node.parentId ? document.nodes.get(node.parentId) : undefined;
  const parentSize = parent ? rawSize(parent) : undefined;
  const parentMaxDimension = parentSize
    ? Math.max(parentSize.width, parentSize.height)
    : 0;
  return (
    maxDimension <= COMPACT_ICON_DIMENSION ||
    parentMaxDimension >= LARGE_DESIGN_CONTEXT_DIMENSION
  );
}
