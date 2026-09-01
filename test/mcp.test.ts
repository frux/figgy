import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { syntheticRenderableFig } from "./helpers/renderable-fig.js";
import { syntheticCanvas } from "./helpers/synthetic-fig.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function fixturePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "figgy-mcp-test-"));
  const path = join(directory, "fixture.fig");
  await writeFile(path, await syntheticRenderableFig());
  return path;
}

async function metadataFixturePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "figgy-mcp-metadata-test-"));
  const path = join(directory, "metadata.fig");
  await writeFile(path, syntheticCanvas());
  return path;
}

describe("figgy MCP server", () => {
  it("serves multiple local files through one stdio process", async () => {
    const renderableFile = await fixturePath();
    const metadataFile = await metadataFixturePath();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts", "mcp"],
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
      for (const tool of tools.tools) {
        const required = tool.inputSchema.required;
        assert.ok(Array.isArray(required) && required.includes("filePath"));
      }

      const metadata = await client.callTool({
        name: "get_metadata",
        arguments: {
          filePath: metadataFile,
          fileKey: "ignored-for-compatibility",
        },
      });
      assert.equal(metadata.isError, undefined);
      const metadataBlock = metadata.content[0];
      assert.equal(metadataBlock?.type, "text");
      if (metadataBlock?.type !== "text") {
        assert.fail("get_metadata did not return a text content block");
      }
      assert.match(metadataBlock.text, /Top-level pages of the document/);
      assert.match(metadataBlock.text, /Main & states/);
      assert.doesNotMatch(metadataBlock.text, /get_design_context/);

      const otherMetadata = await client.callTool({
        name: "get_metadata",
        arguments: { filePath: renderableFile },
      });
      const otherMetadataBlock = otherMetadata.content[0];
      assert.equal(otherMetadataBlock?.type, "text");
      if (otherMetadataBlock?.type !== "text") {
        assert.fail("second get_metadata call did not return text");
      }
      assert.match(otherMetadataBlock.text, /Synthetic render page/);
      assert.doesNotMatch(otherMetadataBlock.text, /Main & states/);

      await writeFile(metadataFile, await syntheticRenderableFig());
      const refreshedMetadata = await client.callTool({
        name: "get_metadata",
        arguments: { filePath: metadataFile },
      });
      const refreshedBlock = refreshedMetadata.content[0];
      assert.equal(refreshedBlock?.type, "text");
      if (refreshedBlock?.type !== "text") {
        assert.fail("refreshed get_metadata call did not return text");
      }
      assert.match(refreshedBlock.text, /Synthetic render page/);
      assert.doesNotMatch(refreshedBlock.text, /Main & states/);

      const screenshot = await client.callTool({
        name: "get_screenshot",
        arguments: {
          filePath: renderableFile,
          fileKey: "ignored-for-compatibility",
        },
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
