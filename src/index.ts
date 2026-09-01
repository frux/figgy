export { FiggyError } from "./errors.js";
export { inspectDocument } from "./inspect.js";
export { readGoldenFixture, verifyGolden } from "./golden.js";
export { normalizeNodeId } from "./model.js";
export { parseFigFile } from "./parser.js";
export { renderFigFile } from "./render.js";
export {
  getMetadataMcpResult,
  getMetadataText,
  METADATA_IMPLEMENTATION_INSTRUCTION,
} from "./compatibility/metadata.js";
export type {
  FigArchiveInfo,
  FigDocument,
  FigNode,
  McpTextContent,
  McpTextResult,
  RawRecord,
} from "./types.js";
export type { MetadataOptions } from "./compatibility/metadata.js";
export type {
  RenderFormat,
  RenderOptions,
  RenderResult,
} from "./render.js";
export type { DocumentInspection } from "./inspect.js";
export type {
  GoldenVerification,
  MetadataGoldenFixture,
  MetadataGoldenRequest,
} from "./golden.js";
