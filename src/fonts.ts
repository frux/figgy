import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, extname, join } from "node:path";

import type { HostFontLoader } from "@open-pencil/core/text";

const FONT_EXTENSIONS = new Set([".otf", ".ttc", ".ttf"]);

interface FontFile {
  path: string;
  normalizedStem: string;
}

let fontIndexPromise: Promise<FontFile[]> | undefined;

function normalizeFontLabel(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function configuredFontDirectories(): string[] {
  const userHome = homedir();
  const custom = (process.env.FIGGY_FONT_DIRS ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const platformDirectories =
    process.platform === "darwin"
      ? [
          join(userHome, "Library", "Fonts"),
          "/Library/Fonts",
          "/System/Library/Fonts",
          "/System/Library/Fonts/Supplemental",
        ]
      : process.platform === "win32"
        ? [join(process.env.SystemRoot ?? "C:\\Windows", "Fonts")]
        : [
            join(userHome, ".fonts"),
            join(userHome, ".local", "share", "fonts"),
            "/usr/local/share/fonts",
            "/usr/share/fonts",
          ];
  return [...new Set([...custom, ...platformDirectories])];
}

async function collectFontFiles(directory: string, output: FontFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectFontFiles(path, output);
        return;
      }
      if (!entry.isFile()) return;
      const extension = extname(entry.name).toLowerCase();
      if (!FONT_EXTENSIONS.has(extension)) return;
      output.push({
        path,
        normalizedStem: normalizeFontLabel(entry.name.slice(0, -extension.length)),
      });
    }),
  );
}

async function systemFontIndex(): Promise<FontFile[]> {
  if (!fontIndexPromise) {
    fontIndexPromise = (async () => {
      const files: FontFile[] = [];
      for (const directory of configuredFontDirectories()) {
        await collectFontFiles(directory, files);
      }
      return files.sort((left, right) => left.path.localeCompare(right.path));
    })();
  }
  return fontIndexPromise;
}

function candidateScore(
  file: FontFile,
  normalizedFamily: string,
  normalizedStyle: string,
): number {
  const exactFamilyStyle = `${normalizedFamily}${normalizedStyle}`;
  if (file.normalizedStem === exactFamilyStyle) return 100;
  if (normalizedStyle === "regular" && file.normalizedStem === normalizedFamily) {
    return 95;
  }
  if (!file.normalizedStem.startsWith(normalizedFamily)) return 0;
  if (file.normalizedStem.includes(normalizedStyle)) return 80;
  return normalizedStyle === "regular" ? 40 : 0;
}

async function readFont(path: string): Promise<ArrayBuffer | null> {
  try {
    const bytes = await readFile(path);
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  } catch {
    return null;
  }
}

/**
 * Resolve fonts strictly from local filesystem directories. The loader never
 * calls a network service and never exposes requested family names or glyphs.
 */
export function createSystemFontLoader(): HostFontLoader {
  return async (family, style) => {
    const normalizedFamily = normalizeFontLabel(family);
    const normalizedStyle = normalizeFontLabel(style || "Regular");
    const candidates = (await systemFontIndex())
      .map((file) => ({
        file,
        score: candidateScore(file, normalizedFamily, normalizedStyle),
      }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.file.path.localeCompare(right.file.path),
      );
    const best = candidates[0];
    return best ? readFont(best.file.path) : null;
  };
}
