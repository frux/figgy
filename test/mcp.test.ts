import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { syntheticRenderableFig } from "./helpers/renderable-fig.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function fixturePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "figgy-mcp-test-"));
  const path = join(directory, "fixture.fig");
  await writeFile(path, await syntheticRenderableFig());
  return path;
}

describe("figgy MCP server", () => {
  it("serves metadata and screenshots through the official stdio client", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "mcp", await fixturePath()],
      cwd: PROJECT_ROOT,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const client = new Client({ name: "figgy-test", version: "0.0.0" });
    try {
      await client.connect(transport);

      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map(({ name }) => name).sort(),
        ["get_metadata", "get_screenshot"],
      );

      const metadata = await client.callTool({
        name: "get_metadata",
        arguments: { fileKey: "ignored-for-compatibility" },
      });
      assert.equal(metadata.isError, undefined);
      const metadataBlock = metadata.content[0];
      assert.equal(metadataBlock?.type, "text");
      if (metadataBlock?.type !== "text") {
        assert.fail("get_metadata did not return a text content block");
      }
      assert.match(metadataBlock.text, /Top-level pages of the document/);
      assert.doesNotMatch(metadataBlock.text, /get_design_context/);

      const screenshot = await client.callTool({
        name: "get_screenshot",
        arguments: { fileKey: "ignored-for-compatibility" },
      });
      assert.equal(screenshot.isError, undefined);
      const imageBlock = screenshot.content[0];
      assert.equal(imageBlock?.type, "image");
      if (imageBlock?.type !== "image") {
        assert.fail("get_screenshot did not return an image content block");
      }
      assert.equal(imageBlock.mimeType, "image/png");
      const png = Buffer.from(imageBlock.data, "base64");
      assert.deepEqual(png.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
    } finally {
      await client.close();
    }

    assert.equal(stderr, "");
  });
});
