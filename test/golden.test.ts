import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getMetadataMcpResult } from "../src/compatibility/metadata.js";
import { decodeCanvas } from "../src/decoder.js";
import {
  type MetadataGoldenFixture,
  verifyGolden,
} from "../src/golden.js";
import { buildDocument } from "../src/model.js";
import { syntheticCanvas } from "./helpers/synthetic-fig.js";

function documentFixture() {
  const decoded = decodeCanvas(syntheticCanvas());
  return buildDocument(decoded.root, {
    formatVersion: decoded.formatVersion,
    archive: { kind: "legacy-canvas", entries: [] },
  });
}

describe("golden verification", () => {
  it("matches a captured MCP envelope", () => {
    const document = documentFixture();
    const request = { nodeId: "1:2" };
    const fixture: MetadataGoldenFixture = {
      schemaVersion: 1,
      tool: "get_metadata",
      request,
      response: getMetadataMcpResult(document, request),
    };

    assert.deepEqual(verifyGolden(document, fixture), {
      matches: true,
      tool: "get_metadata",
      actualResponse: fixture.response,
    });
  });

  it("reports the first structural difference", () => {
    const document = documentFixture();
    const fixture: MetadataGoldenFixture = {
      schemaVersion: 1,
      tool: "get_metadata",
      request: { nodeId: "1:2" },
      response: { content: [{ type: "text", text: "different" }] },
    };

    const result = verifyGolden(document, fixture);
    assert.equal(result.matches, false);
    assert.equal(result.differencePath, "$.content[0].text");
    assert.equal(result.expected, "different");
    assert.match(String(result.actual), /<frame/);
  });
});
