import type { FigDocument, FigNode, RawRecord } from "./types.js";

export interface DocumentInspection {
  formatVersion: number;
  container: "archive" | "legacy-canvas";
  name?: string;
  nodeCount: number;
  rootCount: number;
  pageCount: number;
  pages: Array<{
    id: string;
    name: string;
    childCount: number;
  }>;
  nodeTypes: Record<string, number>;
  archiveEntries: readonly string[];
}

function metaName(meta: RawRecord | undefined): string | undefined {
  if (!meta) return undefined;
  for (const candidate of [meta.name, meta.fileName, meta.documentName]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function pageSummary(page: FigNode): DocumentInspection["pages"][number] {
  return { id: page.id, name: page.name, childCount: page.children.length };
}

export function inspectDocument(document: FigDocument): DocumentInspection {
  const nodeTypes: Record<string, number> = {};
  for (const node of document.nodes.values()) {
    nodeTypes[node.type] = (nodeTypes[node.type] ?? 0) + 1;
  }

  const name = metaName(document.archive.meta);
  return {
    formatVersion: document.formatVersion,
    container: document.archive.kind,
    ...(name ? { name } : {}),
    nodeCount: document.nodes.size,
    rootCount: document.roots.length,
    pageCount: document.pages.length,
    pages: document.pages.map(pageSummary),
    nodeTypes: Object.fromEntries(
      Object.entries(nodeTypes).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    archiveEntries: document.archive.entries,
  };
}
