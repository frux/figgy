#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { initCanvasKit } from "@open-pencil/core/io/formats/raster";

function usage() {
  return "Usage: node scripts/compare-renders.mjs <reference.png> <actual.png> [diff.png]";
}

async function decodePng(ck, path) {
  const bytes = await readFile(path);
  const image = ck.MakeImageFromEncoded(bytes);
  if (!image) throw new Error(`Cannot decode ${path}`);
  const width = image.width();
  const height = image.height();
  const pixels = image.readPixels(0, 0, {
    alphaType: ck.AlphaType.Unpremul,
    colorType: ck.ColorType.RGBA_8888,
    colorSpace: ck.ColorSpace.SRGB,
    width,
    height,
  });
  image.delete();
  if (!(pixels instanceof Uint8Array)) {
    throw new Error(`Cannot read RGBA pixels from ${path}`);
  }
  return { width, height, pixels };
}

function percentage(count, total) {
  return Number(((count / total) * 100).toFixed(4));
}

function compare(reference, actual) {
  if (reference.width !== actual.width || reference.height !== actual.height) {
    throw new Error(
      `Image dimensions differ: ${reference.width}x${reference.height} vs ` +
        `${actual.width}x${actual.height}`,
    );
  }

  const pixelCount = reference.width * reference.height;
  const thresholdCounts = new Map([
    [4, 0],
    [8, 0],
    [16, 0],
    [32, 0],
  ]);
  const diff = new Uint8Array(reference.pixels.length);
  let exactPixels = 0;
  let absoluteSum = 0;
  let squaredSum = 0;
  let maximumChannelDelta = 0;

  for (let offset = 0; offset < reference.pixels.length; offset += 4) {
    let maximumPixelDelta = 0;
    let exact = true;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(
        reference.pixels[offset + channel] - actual.pixels[offset + channel],
      );
      if (delta !== 0) exact = false;
      if (channel < 3) {
        absoluteSum += delta;
        squaredSum += delta * delta;
        maximumPixelDelta = Math.max(maximumPixelDelta, delta);
        maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      }
    }
    if (exact) exactPixels += 1;
    for (const threshold of thresholdCounts.keys()) {
      if (maximumPixelDelta > threshold) {
        thresholdCounts.set(threshold, thresholdCounts.get(threshold) + 1);
      }
    }

    // Perceptual heatmap: low deltas stay dark, large deltas become bright red.
    const intensity = Math.min(255, maximumPixelDelta * 4);
    diff[offset] = intensity;
    diff[offset + 1] = Math.floor(intensity * 0.15);
    diff[offset + 2] = Math.floor(intensity * 0.15);
    diff[offset + 3] = 255;
  }

  const channelCount = pixelCount * 3;
  const meanAbsoluteError = absoluteSum / channelCount;
  const rmse = Math.sqrt(squaredSum / channelCount);
  const psnr = rmse === 0 ? null : 20 * Math.log10(255 / rmse);
  return {
    diff,
    metrics: {
      width: reference.width,
      height: reference.height,
      pixelCount,
      exactPixelPercentage: percentage(exactPixels, pixelCount),
      differingPixelPercentage: percentage(pixelCount - exactPixels, pixelCount),
      meanAbsoluteError: Number(meanAbsoluteError.toFixed(4)),
      rmse: Number(rmse.toFixed(4)),
      psnrDb: psnr === null ? null : Number(psnr.toFixed(4)),
      maximumChannelDelta,
      thresholdedDifferingPixelPercentage: Object.fromEntries(
        [...thresholdCounts].map(([threshold, count]) => [
          `>${threshold}`,
          percentage(count, pixelCount),
        ]),
      ),
    },
  };
}

async function encodeDiff(ck, width, height, pixels, outputPath) {
  const image = ck.MakeImage(
    {
      alphaType: ck.AlphaType.Unpremul,
      colorType: ck.ColorType.RGBA_8888,
      colorSpace: ck.ColorSpace.SRGB,
      width,
      height,
    },
    pixels,
    width * 4,
  );
  if (!image) throw new Error("Cannot create the diff image");
  const encoded = image.encodeToBytes(ck.ImageFormat.PNG, 100);
  image.delete();
  if (!encoded) throw new Error("Cannot encode the diff image");
  await writeFile(outputPath, encoded);
}

const [, , referenceArgument, actualArgument, diffArgument] = process.argv;
if (!referenceArgument || !actualArgument) {
  console.error(usage());
  process.exitCode = 2;
} else {
  try {
    const referencePath = resolve(referenceArgument);
    const actualPath = resolve(actualArgument);
    const diffPath = diffArgument ? resolve(diffArgument) : undefined;
    const ck = await initCanvasKit();
    const [reference, actual] = await Promise.all([
      decodePng(ck, referencePath),
      decodePng(ck, actualPath),
    ]);
    const result = compare(reference, actual);
    if (diffPath) {
      await encodeDiff(ck, reference.width, reference.height, result.diff, diffPath);
    }
    console.log(
      JSON.stringify(
        {
          referencePath,
          actualPath,
          ...(diffPath ? { diffPath } : {}),
          ...result.metrics,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
