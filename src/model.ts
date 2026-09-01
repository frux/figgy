import { FiggyError } from "./errors.js";
import type {
  FigArchiveInfo,
  FigDocument,
  FigNode,
  RawRecord,
} from "./types.js";

function isRecord(value: unknown): value is RawRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findNodeChanges(root: RawRecord): RawRecord[] {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const visited = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > 4 || visited.has(current.value)) continue;
    visited.add(current.value);
    if (!isRecord(current.value)) continue;

    if (Array.isArray(current.value.nodeChanges)) {
      return current.value.nodeChanges.filter(isRecord);
    }
    for (const child of Object.values(current.value)) {
      if (isRecord(child)) queue.push({ value: child, depth: current.depth + 1 });
    }
  }

  throw new FiggyError(
    "The decoded Kiwi message has no nodeChanges array",
    "FIG_NODE_CHANGES_MISSING",
  );
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function guidToId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const session = numberValue(value.sessionID ?? value.sessionId);
  const local = numberValue(value.localID ?? value.localId);
  if (session === undefined || local === undefined) return undefined;
  return `${session}:${local}`;
}

function parentIdOf(raw: RawRecord): string | undefined {
  const parentIndex = isRecord(raw.parentIndex) ? raw.parentIndex : undefined;
  return (
    guidToId(parentIndex?.guid) ??
    guidToId(raw.parentGuid) ??
    guidToId(raw.parentID)
  );
}

function typeOf(raw: RawRecord): string {
  if (typeof raw.type === "string" && raw.type.length > 0) return raw.type;
  if (typeof raw.nodeType === "string" && raw.nodeType.length > 0) {
    return raw.nodeType;
  }
  return "UNKNOWN";
}

function isDeletion(raw: RawRecord): boolean {
  return (
    raw.isDeleted === true ||
    raw.deleted === true ||
    raw.type === "DELETED" ||
    raw.phase === "REMOVED"
  );
}

function makeNode(raw: RawRecord, id: string): FigNode {
  const size = isRecord(raw.size) ? raw.size : undefined;
  const transform = isRecord(raw.transform) ? raw.transform : undefined;
  const parentId = parentIdOf(raw);
  const x = numberValue(transform?.m02 ?? raw.x);
  const y = numberValue(transform?.m12 ?? raw.y);
  const rawWidth = numberValue(size?.x ?? raw.width);
  const rawHeight = numberValue(size?.y ?? raw.height);
  const m00 = numberValue(transform?.m00) ?? 1;
  const m01 = numberValue(transform?.m01) ?? 0;
  const m10 = numberValue(transform?.m10) ?? 0;
  const m11 = numberValue(transform?.m11) ?? 1;
  // Figma metadata reports the axis-aligned dimensions after the node's own
  // transform. For identity transforms this remains the stored size; rotated
  // or skewed geometry needs both matrix columns.
  const width =
    rawWidth !== undefined && rawHeight !== undefined
      ? Math.abs(rawWidth * m00) + Math.abs(rawHeight * m01)
      : rawWidth;
  const height =
    rawWidth !== undefined && rawHeight !== undefined
      ? Math.abs(rawWidth * m10) + Math.abs(rawHeight * m11)
      : rawHeight;
  const visible = typeof raw.visible === "boolean" ? raw.visible : undefined;

  // Canvas nodes have no stored geometry, while the Plugin API represents a
  // page with a zero rectangle and the official MCP includes all four fields.
  const normalizedX = typeOf(raw) === "CANVAS" && x === undefined ? 0 : x;
  const normalizedY = typeOf(raw) === "CANVAS" && y === undefined ? 0 : y;
  const normalizedWidth =
    typeOf(raw) === "CANVAS" && width === undefined ? 0 : width;
  const normalizedHeight =
    typeOf(raw) === "CANVAS" && height === undefined ? 0 : height;

  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    type: typeOf(raw),
    raw,
    children: [],
    ...(parentId ? { parentId } : {}),
    ...(normalizedX !== undefined ? { x: normalizedX } : {}),
    ...(normalizedY !== undefined ? { y: normalizedY } : {}),
    ...(normalizedWidth !== undefined ? { width: normalizedWidth } : {}),
    ...(normalizedHeight !== undefined ? { height: normalizedHeight } : {}),
    ...(visible !== undefined ? { visible } : {}),
  };
}

export interface BuildDocumentOptions {
  formatVersion: number;
  archive: FigArchiveInfo;
}

export function buildDocument(
  decodedRoot: RawRecord,
  options: BuildDocumentOptions,
): FigDocument {
  const changes = findNodeChanges(decodedRoot);
  const rawById = new Map<string, RawRecord>();
  const order: string[] = [];

  for (const change of changes) {
    const id = guidToId(change.guid);
    if (!id) continue;
    if (!rawById.has(id)) order.push(id);

    if (isDeletion(change)) {
      rawById.delete(id);
      continue;
    }

    const previous = rawById.get(id);
    rawById.set(id, previous ? { ...previous, ...change } : change);
  }

  const nodes = new Map<string, FigNode>();
  for (const id of order) {
    const raw = rawById.get(id);
    if (raw) nodes.set(id, makeNode(raw, id));
  }

  const roots: FigNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  // Figma keeps an internal-only canvas for local components and supporting
  // data. It is part of the decoded node graph but is not exposed as a
  // top-level page by the official get_metadata tool.
  const pages = [...nodes.values()].filter(
    (node) => node.type === "CANVAS" && node.raw.internalOnly !== true,
  );
  return {
    formatVersion: options.formatVersion,
    archive: options.archive,
    decodedRoot,
    nodes,
    roots,
    pages,
  };
}

export function normalizeNodeId(input: string): string {
  const match = /^(\-?\d+)(?::|-)(\-?\d+)$/.exec(input.trim());
  if (!match) {
    throw new FiggyError(
      `Invalid node id ${JSON.stringify(input)}; expected session:local or session-local`,
      "FIG_NODE_ID_INVALID",
    );
  }
  return `${Number(match[1])}:${Number(match[2])}`;
}
