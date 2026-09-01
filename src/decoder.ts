import { inflateRawSync, inflateSync } from "node:zlib";
import { compileSchema, decodeBinarySchema } from "@open-pencil/kiwi";
import { decompress as decompressZstd } from "fzstd";

import { FiggyError, describeError } from "./errors.js";
import type { RawRecord } from "./types.js";

const FIG_KIWI_HEADER = Buffer.from("fig-kiwi", "ascii");
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export interface DecodedCanvas {
  formatVersion: number;
  schemaDefinitions: readonly string[];
  rootType: string;
  root: RawRecord;
}

interface CompiledKiwiSchema {
  [name: string]: unknown;
}

function assertAvailable(
  bytes: Buffer,
  offset: number,
  length: number,
  section: string,
): void {
  if (offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new FiggyError(
      `Truncated fig-kiwi ${section} section`,
      "FIG_CANVAS_TRUNCATED",
    );
  }
}

function decompressSchema(bytes: Buffer): Uint8Array {
  try {
    return inflateRawSync(bytes);
  } catch (error) {
    throw new FiggyError(
      `Cannot decompress the embedded Kiwi schema: ${describeError(error)}`,
      "FIG_SCHEMA_DECOMPRESSION_FAILED",
      { cause: error },
    );
  }
}

function decompressMessage(bytes: Buffer): Uint8Array {
  if (bytes.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try {
      return decompressZstd(bytes);
    } catch (error) {
      throw new FiggyError(
        `Cannot decompress the zstd document payload: ${describeError(error)}`,
        "FIG_MESSAGE_DECOMPRESSION_FAILED",
        { cause: error },
      );
    }
  }

  try {
    return inflateRawSync(bytes);
  } catch (rawError) {
    try {
      return inflateSync(bytes);
    } catch {
      throw new FiggyError(
        `Cannot decompress the document payload: ${describeError(rawError)}`,
        "FIG_MESSAGE_DECOMPRESSION_FAILED",
        { cause: rawError },
      );
    }
  }
}

function isRecord(value: unknown): value is RawRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasNodeChanges(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Array.isArray(value.nodeChanges)) return true;

  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth >= 3 || visited.has(current.value)) continue;
    visited.add(current.value);
    if (!isRecord(current.value)) continue;

    for (const child of Object.values(current.value)) {
      if (isRecord(child) && Array.isArray(child.nodeChanges)) return true;
      if (isRecord(child)) queue.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}

function decoderCandidates(
  compiled: CompiledKiwiSchema,
  definitions: readonly string[],
): string[] {
  const preferred = ["Message", "Document", "File", "Canvas"];
  const ordered = [
    ...preferred.filter((name) => definitions.includes(name)),
    ...definitions.filter((name) => !preferred.includes(name)),
  ];
  return ordered.filter(
    (name) => typeof compiled[`decode${name}`] === "function",
  );
}

function decodeRoot(
  compiled: CompiledKiwiSchema,
  definitions: readonly string[],
  payload: Uint8Array,
): { rootType: string; root: RawRecord } {
  const failures: string[] = [];
  for (const type of decoderCandidates(compiled, definitions)) {
    const decoder = compiled[`decode${type}`] as (
      bytes: Uint8Array,
    ) => unknown;
    try {
      // Kiwi's generated decoder resolves ByteBuffer through `this`, so retain
      // the compiled schema as the receiver instead of detaching the method.
      const decoded = decoder.call(compiled, payload);
      if (hasNodeChanges(decoded)) {
        return { rootType: type, root: decoded as RawRecord };
      }
    } catch (error) {
      if (failures.length < 3) failures.push(`${type}: ${describeError(error)}`);
    }
  }

  const detail = failures.length > 0 ? ` (${failures.join("; ")})` : "";
  throw new FiggyError(
    `No Kiwi root decoder produced a nodeChanges document${detail}`,
    "FIG_ROOT_DECODER_NOT_FOUND",
  );
}

export function decodeCanvas(canvas: Buffer): DecodedCanvas {
  assertAvailable(canvas, 0, 16, "header");
  if (!canvas.subarray(0, 8).equals(FIG_KIWI_HEADER)) {
    throw new FiggyError(
      "canvas.fig does not start with the fig-kiwi header",
      "FIG_CANVAS_HEADER_INVALID",
    );
  }

  const formatVersion = canvas.readUInt32LE(8);
  const schemaLength = canvas.readUInt32LE(12);
  const schemaStart = 16;
  assertAvailable(canvas, schemaStart, schemaLength, "schema");

  const messageLengthOffset = schemaStart + schemaLength;
  assertAvailable(canvas, messageLengthOffset, 4, "message length");
  const messageLength = canvas.readUInt32LE(messageLengthOffset);
  const messageStart = messageLengthOffset + 4;
  assertAvailable(canvas, messageStart, messageLength, "message");

  const schemaBytes = decompressSchema(
    canvas.subarray(schemaStart, schemaStart + schemaLength),
  );
  const messageBytes = decompressMessage(
    canvas.subarray(messageStart, messageStart + messageLength),
  );

  let schema: ReturnType<typeof decodeBinarySchema>;
  let compiled: CompiledKiwiSchema;
  try {
    schema = decodeBinarySchema(schemaBytes);
    compiled = compileSchema(schema) as CompiledKiwiSchema;
  } catch (error) {
    throw new FiggyError(
      `Cannot compile the embedded Kiwi schema: ${describeError(error)}`,
      "FIG_SCHEMA_COMPILATION_FAILED",
      { cause: error },
    );
  }

  const definitions = schema.definitions.map(({ name }) => name);
  const decoded = decodeRoot(compiled, definitions, messageBytes);
  return {
    formatVersion,
    schemaDefinitions: definitions,
    rootType: decoded.rootType,
    root: decoded.root,
  };
}
