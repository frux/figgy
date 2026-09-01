import { readFile } from "node:fs/promises";

import { getMetadataMcpResult } from "./compatibility/metadata.js";
import { FiggyError } from "./errors.js";
import type { FigDocument, McpTextResult, RawRecord } from "./types.js";

export interface MetadataGoldenRequest {
  nodeId?: string;
  maxDepth?: number;
  includeImplementationInstruction?: boolean;
}

export interface MetadataGoldenFixture {
  schemaVersion: 1;
  tool: "get_metadata";
  request: MetadataGoldenRequest;
  response: McpTextResult;
  provenance?: {
    capturedAt?: string;
    figmaMcpVersion?: string;
    sourceFileSha256?: string;
    note?: string;
  };
}

export interface GoldenVerification {
  matches: boolean;
  tool: MetadataGoldenFixture["tool"];
  differencePath?: string;
  expected?: unknown;
  actual?: unknown;
  actualResponse: McpTextResult;
}

function isRecord(value: unknown): value is RawRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateFixture(value: unknown): MetadataGoldenFixture {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new FiggyError(
      "Golden fixture must be an object with schemaVersion: 1",
      "GOLDEN_SCHEMA_INVALID",
    );
  }
  if (value.tool !== "get_metadata") {
    throw new FiggyError(
      `Unsupported golden tool ${JSON.stringify(value.tool)}`,
      "GOLDEN_TOOL_UNSUPPORTED",
    );
  }
  if (!isRecord(value.request) || !isRecord(value.response)) {
    throw new FiggyError(
      "Golden fixture must contain request and response objects",
      "GOLDEN_SCHEMA_INVALID",
    );
  }
  if (!Array.isArray(value.response.content)) {
    throw new FiggyError(
      "Golden response must contain a content array",
      "GOLDEN_SCHEMA_INVALID",
    );
  }
  return value as unknown as MetadataGoldenFixture;
}

export async function readGoldenFixture(
  path: string,
): Promise<MetadataGoldenFixture> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new FiggyError(
      `Cannot read golden fixture ${path}`,
      "GOLDEN_FILE_INVALID",
      { cause: error },
    );
  }
  return validateFixture(value);
}

function normalizedString(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function normalized(value: unknown): unknown {
  if (typeof value === "string") return normalizedString(value);
  if (Array.isArray(value)) return value.map(normalized);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalized(child)]),
    );
  }
  return value;
}

interface Difference {
  path: string;
  expected: unknown;
  actual: unknown;
}

function firstDifference(
  expected: unknown,
  actual: unknown,
  path = "$",
): Difference | undefined {
  if (Object.is(expected, actual)) return undefined;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      const difference = firstDifference(
        expected[index],
        actual[index],
        `${path}[${index}]`,
      );
      if (difference) return difference;
    }
    return undefined;
  } else if (isRecord(expected) && isRecord(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      const difference = firstDifference(
        expected[key],
        actual[key],
        `${path}.${key}`,
      );
      if (difference) return difference;
    }
    return undefined;
  }
  return { path, expected, actual };
}

export function verifyGolden(
  document: FigDocument,
  fixture: MetadataGoldenFixture,
): GoldenVerification {
  const options = {
    ...(fixture.request.nodeId !== undefined
      ? { nodeId: fixture.request.nodeId }
      : {}),
    ...(fixture.request.maxDepth !== undefined
      ? { maxDepth: fixture.request.maxDepth }
      : {}),
    ...(fixture.request.includeImplementationInstruction !== undefined
      ? {
          includeImplementationInstruction:
            fixture.request.includeImplementationInstruction,
        }
      : {}),
  };
  const actualResponse = getMetadataMcpResult(document, options);
  const difference = firstDifference(
    normalized(fixture.response),
    normalized(actualResponse),
  );
  return {
    matches: difference === undefined,
    tool: fixture.tool,
    actualResponse,
    ...(difference
      ? {
          differencePath: difference.path,
          expected: difference.expected,
          actual: difference.actual,
        }
      : {}),
  };
}
