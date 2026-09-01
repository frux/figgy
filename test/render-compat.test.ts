import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SceneGraph, type Mat3 } from "@open-pencil/scene-graph";

import { renderCompatibilityInternals } from "../src/render.js";

function geometryBlob(...points: Array<[number, number]>): Uint8Array {
  const blob = new Uint8Array(points.length * 9 + 1);
  const view = new DataView(blob.buffer);
  let offset = 0;
  for (const [x, y] of points) {
    blob[offset] = offset === 0 ? 1 : 2;
    offset += 1;
    view.setFloat32(offset, x, true);
    view.setFloat32(offset + 4, y, true);
    offset += 8;
  }
  blob[offset] = 0;
  return blob;
}

function geometryPoints(blob: Uint8Array): Array<[number, number]> {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const points: Array<[number, number]> = [];
  let offset = 0;
  while (offset < blob.byteLength) {
    const command = blob[offset];
    offset += 1;
    if (command === 0) continue;
    assert.ok(command === 1 || command === 2);
    points.push([
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
    ]);
    offset += 8;
  }
  return points;
}

describe("Figma render compatibility", () => {
  it("applies a general affine matrix to imported path commands", () => {
    const input = geometryBlob([1, 2], [-3, 4]);
    const original = new Uint8Array(input);
    const matrix: Mat3 = [2, 0.5, 7, -0.25, 3, -5, 0, 0, 1];

    const output = renderCompatibilityInternals.transformCommandsBlob(
      input,
      matrix,
    );

    assert.deepEqual(geometryPoints(output), [
      [10, 0.75],
      [3, 7.75],
    ]);
    assert.deepEqual(input, original, "the imported FIG blob remains immutable");
  });

  it("keeps imported boolean geometry instead of lossy child recomputation", () => {
    const graph = new SceneGraph();
    const page = graph.getPages()[0];
    assert.ok(page);
    const operation = graph.createNode("BOOLEAN_OPERATION", page.id, {
      fillGeometry: [
        {
          commandsBlob: geometryBlob([0, 0], [20, 0], [20, 20]),
          windingRule: "NONZERO",
        },
      ],
    });
    graph.createNode("RECTANGLE", operation.id, {
      width: 20,
      height: 20,
    });
    assert.equal(operation.childIds.length, 1);

    renderCompatibilityInternals.preferImportedBooleanGeometry(graph);

    assert.deepEqual(operation.childIds, []);
  });

  it("treats embedded Figma glyphs and their layout as authoritative", () => {
    const graph = new SceneGraph();
    const page = graph.getPages()[0];
    assert.ok(page);
    const text = graph.createNode("TEXT", page.id, {
      text: "Synthetic",
      fontFamily: "Unavailable test family",
      textAutoResize: "HEIGHT",
      figmaDerivedTextGlyphs: [
        {
          commandsBlob: geometryBlob([0, 0], [1, 0], [1, 1]),
          x: 0,
          y: 10,
          fontSize: 12,
        },
      ],
    });

    renderCompatibilityInternals.preferFigmaDerivedText(graph);

    assert.equal(text.textAutoResize, "NONE");
    assert.match(text.fontFamily, /^__figgy_/);
  });
});
