import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { parseFigFile } from "../src/parser.js";
import {
  syntheticCanvas,
  syntheticFigArchive,
} from "./helpers/synthetic-fig.js";

describe("parseFigFile", () => {
  it("parses a legacy fig-kiwi file from disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figgy-test-"));
    const path = join(directory, "fixture.fig");
    await writeFile(path, syntheticCanvas());

    const document = await parseFigFile(path);
    assert.equal(document.archive.kind, "legacy-canvas");
    assert.equal(document.nodes.get("1:3")?.name, "Title <h1>");
  });

  it("reads canvas and metadata from a ZIP archive with data descriptors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figgy-test-"));
    const path = join(directory, "fixture.fig");
    await writeFile(path, syntheticFigArchive());

    const document = await parseFigFile(path);
    assert.equal(document.archive.kind, "archive");
    assert.equal(document.archive.meta?.name, "Synthetic fixture");
    assert.deepEqual(document.archive.entries, [
      "canvas.fig",
      "meta.json",
      "images/",
    ]);
    assert.equal(document.pages[0]?.id, "0:1");
  });

  it("rejects unrelated binary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figgy-test-"));
    const path = join(directory, "not-a-fig.bin");
    await writeFile(path, "not a fig file");

    await assert.rejects(() => parseFigFile(path), /neither a modern ZIP-based/);
  });
});
