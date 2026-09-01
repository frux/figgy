import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeCanvas } from "../src/decoder.js";
import { buildDocument } from "../src/model.js";
import { syntheticCanvas } from "./helpers/synthetic-fig.js";

describe("fig-kiwi decoder", () => {
  it("decodes an embedded schema and reconstructs the node tree", () => {
    const decoded = decodeCanvas(syntheticCanvas());
    const document = buildDocument(decoded.root, {
      formatVersion: decoded.formatVersion,
      archive: { kind: "legacy-canvas", entries: [] },
    });

    assert.equal(decoded.formatVersion, 101);
    assert.equal(decoded.rootType, "Message");
    assert.equal(document.nodes.size, 4);
    assert.deepEqual(
      document.pages.map(({ id, name }) => ({ id, name })),
      [{ id: "0:1", name: "Main & states" }],
    );

    const frame = document.nodes.get("1:2");
    assert.ok(frame);
    assert.equal(frame.parentId, "0:1");
    assert.equal(frame.x, 12.5);
    assert.equal(frame.width, 320);
    assert.deepEqual(
      frame.children.map(({ id }) => id),
      ["1:3"],
    );
  });

  it("reports axis-aligned dimensions after the node transform", () => {
    const root = {
      nodeChanges: [
        {
          guid: { sessionID: 0, localID: 0 },
          type: "DOCUMENT",
          name: "Document",
        },
        {
          guid: { sessionID: 0, localID: 1 },
          parentIndex: { guid: { sessionID: 0, localID: 0 } },
          type: "CANVAS",
          name: "Page",
        },
        {
          guid: { sessionID: 1, localID: 1 },
          parentIndex: { guid: { sessionID: 0, localID: 1 } },
          type: "VECTOR",
          name: "Rotated shape",
          size: { x: 20, y: 10 },
          transform: { m00: 0, m01: -1, m02: 5, m10: 1, m11: 0, m12: 6 },
        },
      ],
    };
    const document = buildDocument(root, {
      formatVersion: 106,
      archive: { kind: "legacy-canvas", entries: [] },
    });

    assert.deepEqual(
      {
        x: document.nodes.get("1:1")?.x,
        y: document.nodes.get("1:1")?.y,
        width: document.nodes.get("1:1")?.width,
        height: document.nodes.get("1:1")?.height,
      },
      { x: 5, y: 6, width: 10, height: 20 },
    );
    assert.deepEqual(
      {
        x: document.nodes.get("0:1")?.x,
        y: document.nodes.get("0:1")?.y,
        width: document.nodes.get("0:1")?.width,
        height: document.nodes.get("0:1")?.height,
      },
      { x: 0, y: 0, width: 0, height: 0 },
    );
  });

  it("rejects a truncated canvas with a stable error code", () => {
    assert.throws(
      () => decodeCanvas(Buffer.from("fig-kiwi")),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "FIG_CANVAS_TRUNCATED",
    );
  });

  it("keeps internal canvases in the graph but hides them from page listings", () => {
    const root = {
      nodeChanges: [
        {
          guid: { sessionID: 0, localID: 0 },
          type: "DOCUMENT",
          name: "Document",
        },
        {
          guid: { sessionID: 0, localID: 1 },
          parentIndex: { guid: { sessionID: 0, localID: 0 } },
          type: "CANVAS",
          name: "Visible page",
        },
        {
          guid: { sessionID: 0, localID: 2 },
          parentIndex: { guid: { sessionID: 0, localID: 0 } },
          type: "CANVAS",
          name: "Internal page",
          internalOnly: true,
        },
      ],
    };
    const document = buildDocument(root, {
      formatVersion: 106,
      archive: { kind: "legacy-canvas", entries: [] },
    });

    assert.equal(document.nodes.get("0:2")?.raw.internalOnly, true);
    assert.deepEqual(
      document.pages.map(({ id }) => id),
      ["0:1"],
    );
  });
});
