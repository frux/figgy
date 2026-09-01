import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { fontManager } from "@open-pencil/core/text";

import { FiggyError } from "../src/errors.js";
import { parseFigFile } from "../src/parser.js";
import { renderFigFile } from "../src/render.js";
import { syntheticRenderableFig } from "./helpers/renderable-fig.js";

async function fixture(): Promise<{ directory: string; fig: string }> {
  const directory = await mkdtemp(join(tmpdir(), "figgy-render-test-"));
  const fig = join(directory, "fixture.fig");
  await writeFile(fig, await syntheticRenderableFig());
  return { directory, fig };
}

describe("local rendering", () => {
  it("renders a safe synthetic FIG page to SVG", async () => {
    const { directory, fig } = await fixture();
    const output = join(directory, "page.svg");
    const result = await renderFigFile(fig, { outputPath: output });

    assert.equal(result.format, "svg");
    assert.equal(result.mimeType, "image/svg+xml");
    assert.equal(result.outputPath, output);
    assert.match(await readFile(output, "utf8"), /<svg[ >]/);
  });

  it("uses the same Figma node ids as metadata parsing", async () => {
    const { directory, fig } = await fixture();
    const document = await parseFigFile(fig);
    const rectangle = [...document.nodes.values()].find(
      (node) => node.type === "RECTANGLE",
    );
    assert.ok(rectangle);

    const output = join(directory, "node.svg");
    const result = await renderFigFile(fig, {
      nodeId: rectangle.id,
      outputPath: output,
    });
    assert.equal(result.format, "svg");
    assert.match(await readFile(output, "utf8"), /<rect[ >]/);
  });

  it("renders PNG locally and fits it to the requested maximum dimension", async () => {
    const { directory, fig } = await fixture();
    const output = join(directory, "page.png");
    const result = await renderFigFile(fig, {
      outputPath: output,
      maxDimension: 60,
    });
    const png = await readFile(output);

    assert.deepEqual(
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    assert.equal(result.width, 60);
    assert.equal(result.height, 40);
    assert.equal(result.requestedScale, 1);
    assert.equal(result.effectiveScale, 0.5);
    assert.deepEqual(fontManager.enabledOnlineFontProviders(), []);
  });

  it("does not overwrite an existing render unless force is explicit", async () => {
    const { directory, fig } = await fixture();
    const output = join(directory, "page.svg");
    await writeFile(output, "keep me");

    await assert.rejects(
      () => renderFigFile(fig, { outputPath: output }),
      (error: unknown) =>
        error instanceof FiggyError &&
        error.code === "FIG_RENDER_OUTPUT_EXISTS",
    );
    assert.equal(await readFile(output, "utf8"), "keep me");
  });

  it("rejects incompatible targets and SVG raster options", async () => {
    const { fig } = await fixture();
    await assert.rejects(
      () => renderFigFile(fig, { nodeId: "1:2", page: "Page" }),
      /either a node or a page/,
    );
    await assert.rejects(
      () => renderFigFile(fig, { format: "svg", scale: 2 }),
      /only available for PNG/,
    );
  });
});
