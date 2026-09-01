#!/usr/bin/env node

import { resolve } from "node:path";

import { getMetadataMcpResult, getMetadataText } from "./compatibility/metadata.js";
import { FiggyError, describeError } from "./errors.js";
import { readGoldenFixture, verifyGolden } from "./golden.js";
import { inspectDocument } from "./inspect.js";
import { runFiggyMcpServer } from "./mcp.js";
import { parseFigFile } from "./parser.js";
import { renderFigFile, type RenderFormat } from "./render.js";

const VERSION = "0.1.0";

const HELP = `figgy ${VERSION}

Local MCP server and standalone CLI for Figma .fig files.

Usage:
  figgy mcp <file.fig>
  figgy inspect <file.fig>
  figgy get-metadata <file.fig> [--node <session:local>] [options]
  figgy render <file.fig> [--node <session:local> | --page <name-or-id>] [options]
  figgy verify <file.fig> <golden.json>

Commands:
  mcp              Serve one local .fig file as an MCP server over stdio
  inspect          Print a JSON summary of the archive and document tree
  get-metadata     Emit sparse Figma MCP-style XML (alias: get_metadata)
  render           Render a page or node to a local PNG/SVG file
  verify           Compare the local MCP envelope with a captured golden

get-metadata options:
  --node <id>      Node id in 1:2 or URL-style 1-2 form
  --depth <n>      Stop after n descendant levels
  --format <kind>  text (default) or mcp (JSON content envelope)
  --no-instructions
                   Omit Figma's implementation reminder from text output

render options:
  --node <id>      Render one node; accepts 1:2 or URL-style 1-2
  --page <value>   Render a page selected by exact name or id
  -o, --output     Output path; default: sibling .png/.svg file
  --format <kind>  png (default) or svg; inferred from output extension
  --scale <n>      PNG scale from 0.01 through 8 (default: 1)
  --max-dimension <px>
                   Downscale PNG to fit this edge length (default: 4096)
  --force          Replace an existing output file

General options:
  -h, --help       Show this help
  -v, --version    Show the version
`;

const MCP_HELP = `figgy mcp <file.fig>

Run a read-only MCP server over stdio, bound to one local Figma .fig file.

Tools:
  get_metadata      List pages or return sparse XML for a node subtree
  get_screenshot    Render a page or node and return a PNG image block
`;

interface MetadataArguments {
  file: string;
  nodeId?: string;
  maxDepth?: number;
  format: "text" | "mcp";
  includeImplementationInstruction: boolean;
}

interface RenderArguments {
  file: string;
  nodeId?: string;
  page?: string;
  outputPath?: string;
  format?: RenderFormat;
  scale?: number;
  maxDimension?: number;
  force: boolean;
}

function takeValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new FiggyError(`${option} requires a value`, "CLI_ARGUMENT_MISSING");
  }
  return value;
}

function parseMetadataArguments(args: string[]): MetadataArguments {
  const positionals: string[] = [];
  let nodeId: string | undefined;
  let maxDepth: number | undefined;
  let format: "text" | "mcp" = "text";
  let includeImplementationInstruction = true;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--node") {
      nodeId = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--depth") {
      const value = takeValue(args, index, argument);
      maxDepth = Number(value);
      if (!Number.isInteger(maxDepth) || maxDepth < 0) {
        throw new FiggyError(
          `--depth must be a non-negative integer, received ${JSON.stringify(value)}`,
          "CLI_ARGUMENT_INVALID",
        );
      }
      index += 1;
    } else if (argument === "--format") {
      const value = takeValue(args, index, argument);
      if (value !== "text" && value !== "mcp") {
        throw new FiggyError(
          `--format must be text or mcp, received ${JSON.stringify(value)}`,
          "CLI_ARGUMENT_INVALID",
        );
      }
      format = value;
      index += 1;
    } else if (argument === "--no-instructions") {
      includeImplementationInstruction = false;
    } else if (argument?.startsWith("-")) {
      throw new FiggyError(`Unknown option ${argument}`, "CLI_ARGUMENT_UNKNOWN");
    } else if (argument !== undefined) {
      positionals.push(argument);
    }
  }

  const file = positionals[0];
  if (!file) {
    throw new FiggyError("get-metadata requires a .fig file", "CLI_FILE_MISSING");
  }
  if (positionals.length > 1) {
    throw new FiggyError(
      `Unexpected argument ${positionals[1]}`,
      "CLI_ARGUMENT_UNKNOWN",
    );
  }

  return {
    file,
    format,
    includeImplementationInstruction,
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  };
}

function parseRenderArguments(args: string[]): RenderArguments {
  const positionals: string[] = [];
  let nodeId: string | undefined;
  let page: string | undefined;
  let outputPath: string | undefined;
  let format: RenderFormat | undefined;
  let scale: number | undefined;
  let maxDimension: number | undefined;
  let force = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--node") {
      nodeId = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--page") {
      page = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "-o" || argument === "--output") {
      outputPath = takeValue(args, index, argument);
      index += 1;
    } else if (argument === "--format") {
      const value = takeValue(args, index, argument);
      if (value !== "png" && value !== "svg") {
        throw new FiggyError(
          `--format must be png or svg, received ${JSON.stringify(value)}`,
          "CLI_ARGUMENT_INVALID",
        );
      }
      format = value;
      index += 1;
    } else if (argument === "--scale") {
      scale = Number(takeValue(args, index, argument));
      index += 1;
    } else if (argument === "--max-dimension") {
      maxDimension = Number(takeValue(args, index, argument));
      index += 1;
    } else if (argument === "--force") {
      force = true;
    } else if (argument?.startsWith("-")) {
      throw new FiggyError(`Unknown option ${argument}`, "CLI_ARGUMENT_UNKNOWN");
    } else if (argument !== undefined) {
      positionals.push(argument);
    }
  }

  const file = positionals[0];
  if (!file) {
    throw new FiggyError("render requires a .fig file", "CLI_FILE_MISSING");
  }
  if (positionals.length > 1) {
    throw new FiggyError(
      `Unexpected argument ${positionals[1]}`,
      "CLI_ARGUMENT_UNKNOWN",
    );
  }
  if (nodeId !== undefined && page !== undefined) {
    throw new FiggyError(
      "--node and --page cannot be used together",
      "CLI_ARGUMENT_CONFLICT",
    );
  }

  return {
    file,
    force,
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(outputPath !== undefined ? { outputPath } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(maxDimension !== undefined ? { maxDimension } : {}),
  };
}

async function runInspect(args: string[]): Promise<void> {
  const file = args[0];
  if (!file) throw new FiggyError("inspect requires a .fig file", "CLI_FILE_MISSING");
  if (args.length > 1) {
    throw new FiggyError(`Unexpected argument ${args[1]}`, "CLI_ARGUMENT_UNKNOWN");
  }
  const document = await parseFigFile(resolve(file));
  process.stdout.write(`${JSON.stringify(inspectDocument(document), null, 2)}\n`);
}

async function runMcp(args: string[]): Promise<void> {
  if (args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(MCP_HELP);
    return;
  }
  const [file, extra] = args;
  if (!file) throw new FiggyError("mcp requires a .fig file", "CLI_FILE_MISSING");
  if (extra) {
    throw new FiggyError(`Unexpected argument ${extra}`, "CLI_ARGUMENT_UNKNOWN");
  }
  await runFiggyMcpServer(resolve(file));
}

async function runMetadata(args: string[]): Promise<void> {
  const options = parseMetadataArguments(args);
  const document = await parseFigFile(resolve(options.file));
  const metadataOptions = {
    includeImplementationInstruction:
      options.includeImplementationInstruction,
    ...(options.nodeId !== undefined ? { nodeId: options.nodeId } : {}),
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
  };
  const result =
    options.format === "mcp"
      ? JSON.stringify(getMetadataMcpResult(document, metadataOptions), null, 2)
      : getMetadataText(document, metadataOptions);
  process.stdout.write(`${result}\n`);
}

async function runRender(args: string[]): Promise<void> {
  const options = parseRenderArguments(args);
  const result = await renderFigFile(options.file, {
    force: options.force,
    ...(options.nodeId !== undefined ? { nodeId: options.nodeId } : {}),
    ...(options.page !== undefined ? { page: options.page } : {}),
    ...(options.outputPath !== undefined
      ? { outputPath: options.outputPath }
      : {}),
    ...(options.format !== undefined ? { format: options.format } : {}),
    ...(options.scale !== undefined ? { scale: options.scale } : {}),
    ...(options.maxDimension !== undefined
      ? { maxDimension: options.maxDimension }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function runVerify(args: string[]): Promise<number> {
  const [file, golden, extra] = args;
  if (!file || !golden) {
    throw new FiggyError(
      "verify requires a .fig file and a golden JSON file",
      "CLI_FILE_MISSING",
    );
  }
  if (extra) {
    throw new FiggyError(`Unexpected argument ${extra}`, "CLI_ARGUMENT_UNKNOWN");
  }

  const [document, fixture] = await Promise.all([
    parseFigFile(resolve(file)),
    readGoldenFixture(resolve(golden)),
  ]);
  const result = verifyGolden(document, fixture);
  if (result.matches) {
    process.stdout.write(`PASS ${fixture.tool}: local response matches golden\n`);
    return 0;
  }

  process.stdout.write(
    [
      `FAIL ${fixture.tool}: first difference at ${result.differencePath ?? "$"}`,
      `expected: ${JSON.stringify(result.expected)}`,
      `actual:   ${JSON.stringify(result.actual)}`,
      "",
    ].join("\n"),
  );
  return 2;
}

export async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === "-h" || command === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "-v" || command === "--version" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    if (command === "mcp") await runMcp(rest);
    else if (command === "inspect") await runInspect(rest);
    else if (command === "get-metadata" || command === "get_metadata") {
      await runMetadata(rest);
    } else if (command === "render") {
      await runRender(rest);
    } else if (command === "verify") {
      return await runVerify(rest);
    } else {
      throw new FiggyError(`Unknown command ${command}`, "CLI_COMMAND_UNKNOWN");
    }
    return 0;
  } catch (error) {
    const prefix = error instanceof FiggyError ? `${error.code}: ` : "";
    process.stderr.write(`figgy: ${prefix}${describeError(error)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
