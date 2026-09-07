import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { syntheticCanvas } from "./helpers/synthetic-fig.js";
import { syntheticRenderableFig } from "./helpers/renderable-fig.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixturePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "figgy-cli-test-"));
  const path = join(directory, "fixture.fig");
  await writeFile(path, syntheticCanvas());
  return path;
}

async function renderableFixturePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "figgy-cli-render-test-"));
  const path = join(directory, "fixture.fig");
  await writeFile(path, await syntheticRenderableFig());
  return path;
}

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  );
}

describe("figgy CLI", () => {
  it("runs when invoked through a package-manager symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "figgy-cli-link-test-"));
    const executable = join(directory, "figgy");
    await symlink(resolve(PROJECT_ROOT, "dist/cli.js"), executable);

    const result = spawnSync(process.execPath, [executable, "--version"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "0.1.1\n");
  });

  it("documents the dedicated MCP mode", () => {
    const result = runCli("mcp", "--help");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^figgy mcp\n/);
    assert.match(result.stdout, /filePath/);
    assert.match(result.stdout, /get_metadata/);
    assert.match(result.stdout, /get_screenshot/);
  });

  it("rejects the old server-bound file argument", () => {
    const result = runCli("mcp", "layout.fig");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pass the path as filePath/);
  });

  it("prints a machine-readable inspection", async () => {
    const result = runCli("inspect", await fixturePath());
    assert.equal(result.status, 0, result.stderr);
    const inspection = JSON.parse(result.stdout) as {
      nodeCount: number;
      pageCount: number;
    };
    assert.equal(inspection.nodeCount, 4);
    assert.equal(inspection.pageCount, 1);
  });

  it("emits an MCP envelope for get-metadata", async () => {
    const result = runCli(
      "get-metadata",
      await fixturePath(),
      "--node",
      "1-2",
      "--format",
      "mcp",
    );
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout) as {
      content: Array<{ type: string; text: string }>;
    };
    assert.equal(response.content[0]?.type, "text");
    assert.match(response.content[0]?.text ?? "", /<frame id="1:2"/);
  });

  it("renders a page and reports the output as JSON", async () => {
    const file = await renderableFixturePath();
    const output = join(dirname(file), "render.svg");
    const result = runCli("render", file, "--output", output);
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout) as {
      outputPath: string;
      format: string;
      mimeType: string;
    };
    assert.equal(response.outputPath, output);
    assert.equal(response.format, "svg");
    assert.equal(response.mimeType, "image/svg+xml");
    assert.match(await readFile(output, "utf8"), /<svg[ >]/);
  });
});
