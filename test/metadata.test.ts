import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getMetadataMcpResult,
  getMetadataText,
  METADATA_IMPLEMENTATION_INSTRUCTION,
} from "../src/compatibility/metadata.js";
import { decodeCanvas } from "../src/decoder.js";
import { buildDocument } from "../src/model.js";
import { syntheticCanvas } from "./helpers/synthetic-fig.js";

function documentFixture() {
  const decoded = decodeCanvas(syntheticCanvas());
  return buildDocument(decoded.root, {
    formatVersion: decoded.formatVersion,
    archive: { kind: "legacy-canvas", entries: [] },
  });
}

describe("Figma MCP-compatible metadata", () => {
  it("lists top-level pages when nodeId is omitted", () => {
    assert.equal(
      getMetadataText(documentFixture(), {
        includeImplementationInstruction: false,
      }),
      [
        "No nodeId was provided. Listing the top-level pages of the document. Call get_metadata again with one of the page ids below (or any node id underneath) to get the XML metadata for that subtree.",
        "",
        "Top-level pages of the document:",
        "- 0:1: Main & states",
      ].join("\n"),
    );
  });

  it("renders sparse recursive XML for a URL-style node id", () => {
    const text = getMetadataText(documentFixture(), {
      nodeId: "1-2",
      includeImplementationInstruction: false,
    });

    assert.equal(
      text,
      [
        '<frame id="1:2" name="Hero &quot;wide&quot;" x="12.5" y="24" width="320" height="200">',
        '  <text id="1:3" name="Title &lt;h1&gt;" x="16" y="20" width="120" height="24" hidden="true" />',
        "</frame>",
      ].join("\n"),
    );
  });

  it("wraps the result in an MCP text content envelope", () => {
    const result = getMetadataMcpResult(documentFixture(), {
      nodeId: "1:2",
      maxDepth: 0,
    });

    assert.equal(result.content.length, 2);
    assert.equal(result.content[0]?.type, "text");
    assert.match(result.content[0]?.text ?? "", /<frame .* \/>/);
    assert.equal(result.content[1]?.text, METADATA_IMPLEMENTATION_INSTRUCTION);
  });

  it("collapses likely vector assets like the official metadata serializer", () => {
    const decoded = decodeCanvas(
      syntheticCanvas([
        { id: [0, 0], type: "DOCUMENT", name: "Document" },
        {
          id: [0, 1],
          parent: [0, 0],
          type: "CANVAS",
          name: "Page",
        },
        {
          id: [1, 1],
          parent: [0, 1],
          type: "FRAME",
          name: "Screen",
          width: 320,
          height: 200,
        },
        {
          id: [1, 2],
          parent: [1, 1],
          type: "FRAME",
          name: "Graphic",
          width: 32,
          height: 32,
        },
        {
          id: [1, 3],
          parent: [1, 2],
          type: "VECTOR",
          name: "Path",
          width: 20,
          height: 20,
        },
      ]),
    );
    const document = buildDocument(decoded.root, {
      formatVersion: decoded.formatVersion,
      archive: { kind: "legacy-canvas", entries: [] },
    });

    const text = getMetadataText(document, {
      nodeId: "1:1",
      includeImplementationInstruction: false,
    });
    assert.match(text, /<frame id="1:2"[^>]* \/>/);
    assert.doesNotMatch(text, /id="1:3"/);
  });

  it("returns page hints for unknown nodes", () => {
    assert.throws(
      () => getMetadataText(documentFixture(), { nodeId: "99:1" }),
      /Available pages: 0:1 \(Main & states\)/,
    );
  });
});
