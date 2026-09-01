export type RawRecord = Record<string, unknown>;

export interface FigArchiveInfo {
  kind: "archive" | "legacy-canvas";
  entries: readonly string[];
  meta?: RawRecord;
}

export interface FigNode {
  id: string;
  name: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  parentId?: string;
  raw: RawRecord;
  children: FigNode[];
}

export interface FigDocument {
  formatVersion: number;
  archive: FigArchiveInfo;
  decodedRoot: RawRecord;
  nodes: Map<string, FigNode>;
  roots: FigNode[];
  pages: FigNode[];
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpTextResult {
  content: McpTextContent[];
  isError?: boolean;
}
