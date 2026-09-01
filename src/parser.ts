import { readFigSource } from "./archive.js";
import { decodeCanvas } from "./decoder.js";
import { buildDocument } from "./model.js";
import type { FigDocument } from "./types.js";

export async function parseFigFile(path: string): Promise<FigDocument> {
  const source = await readFigSource(path);
  const decoded = decodeCanvas(source.canvas);
  return buildDocument(decoded.root, {
    formatVersion: decoded.formatVersion,
    archive: source.archive,
  });
}
