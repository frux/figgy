import { open as openFile, readFile } from "node:fs/promises";
import * as yauzl from "yauzl";

import { FiggyError } from "./errors.js";
import type { FigArchiveInfo, RawRecord } from "./types.js";

const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const FIG_KIWI_HEADER = Buffer.from("fig-kiwi", "ascii");

export interface FigSource {
  canvas: Buffer;
  archive: FigArchiveInfo;
}

async function readPrefix(path: string, length: number): Promise<Buffer> {
  const handle = await openFile(path, "r");
  try {
    const prefix = Buffer.alloc(length);
    const { bytesRead } = await handle.read(prefix, 0, length, 0);
    return prefix.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true },
      (error, zip) => {
        if (error) reject(error);
        else resolve(zip);
      },
    );
  });
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (openError, stream) => {
      if (openError) {
        reject(openError);
        return;
      }

      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer | Uint8Array) => {
        chunks.push(Buffer.from(chunk));
      });
      stream.once("error", reject);
      stream.once("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readArchive(path: string): Promise<FigSource> {
  const zip = await openZip(path);
  const wanted = new Set(["canvas.fig", "meta.json"]);
  const found = new Map<string, Buffer>();
  const entries: string[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      zip.on("error", fail);
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        entries.push(entry.fileName);
        if (!wanted.has(entry.fileName)) {
          zip.readEntry();
          return;
        }

        void readEntry(zip, entry).then(
          (content) => {
            found.set(entry.fileName, content);
            zip.readEntry();
          },
          fail,
        );
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  const canvas = found.get("canvas.fig");
  if (!canvas) {
    throw new FiggyError(
      "The .fig archive does not contain canvas.fig",
      "FIG_ARCHIVE_CANVAS_MISSING",
    );
  }

  let meta: RawRecord | undefined;
  const metaBytes = found.get("meta.json");
  if (metaBytes) {
    try {
      const value: unknown = JSON.parse(metaBytes.toString("utf8"));
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        meta = value as RawRecord;
      }
    } catch (error) {
      throw new FiggyError(
        "The .fig archive contains invalid meta.json",
        "FIG_ARCHIVE_META_INVALID",
        { cause: error },
      );
    }
  }

  return {
    canvas,
    archive: {
      kind: "archive",
      entries,
      ...(meta ? { meta } : {}),
    },
  };
}

export async function readFigSource(path: string): Promise<FigSource> {
  let prefix: Buffer;
  try {
    prefix = await readPrefix(path, 8);
  } catch (error) {
    throw new FiggyError(`Cannot read ${path}`, "FIG_FILE_UNREADABLE", {
      cause: error,
    });
  }

  if (prefix.subarray(0, 4).equals(ZIP_LOCAL_FILE_HEADER)) {
    return readArchive(path);
  }

  if (prefix.equals(FIG_KIWI_HEADER)) {
    return {
      canvas: await readFile(path),
      archive: { kind: "legacy-canvas", entries: [] },
    };
  }

  throw new FiggyError(
    `${path} is neither a modern ZIP-based .fig archive nor a fig-kiwi canvas`,
    "FIG_FORMAT_UNSUPPORTED",
  );
}
