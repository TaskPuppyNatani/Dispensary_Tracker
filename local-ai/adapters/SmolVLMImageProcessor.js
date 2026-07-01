"use strict";

const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");

const DEFAULT_IMAGE_SIZE = 512;
const DEFAULT_LONGEST_EDGE = 2048;
const DEFAULT_RESCALE_FACTOR = 1 / 255;
const DEFAULT_IMAGE_MEAN = Object.freeze([0.5, 0.5, 0.5]);
const DEFAULT_IMAGE_STD = Object.freeze([0.5, 0.5, 0.5]);

class SmolVLMImageProcessor {
  constructor(options = {}) {
    this.config = null;
    this.configPath = "";
    this.processorConfigPath = "";
    this.sharpFactory = options.sharpFactory || sharp;
  }

  async loadConfig(configPathOrModelPath) {
    const resolved = path.resolve(String(configPathOrModelPath || ""));
    const preprocessorConfigPath = await resolvePreprocessorConfigPath(resolved);
    const modelDirectory = path.dirname(preprocessorConfigPath);
    const processorConfigPath = path.join(modelDirectory, "processor_config.json");

    const preprocessorConfig = await readJsonFile(preprocessorConfigPath);
    const processorConfig = await readOptionalJsonFile(processorConfigPath);
    const normalizedConfig = normalizeConfig(preprocessorConfig, processorConfig);

    this.config = normalizedConfig;
    this.configPath = preprocessorConfigPath;
    this.processorConfigPath = processorConfigPath;

    return normalizedConfig;
  }

  async processImage(input, options = {}) {
    const config = options.config || this.config || await this.loadConfig(options.configPath || options.modelPath);
    const imageInput = normalizeImageInput(input);
    const metadata = await this.sharpFactory(imageInput, { failOn: "none" }).metadata();
    const originalWidth = toPositiveInteger(metadata.width, 0);
    const originalHeight = toPositiveInteger(metadata.height, 0);

    if (!originalWidth || !originalHeight) {
      throw new Error("Image dimensions could not be determined.");
    }

    const resizedSize = config.doResize
      ? calculateResizeSize(originalWidth, originalHeight, config.longestEdge)
      : { width: originalWidth, height: originalHeight };
    const resizedRaw = await this.sharpFactory(imageInput, { failOn: "none" })
      .rotate()
      .removeAlpha()
      .resize(resizedSize.width, resizedSize.height, {
        fit: "fill",
        kernel: config.sharpKernel,
      })
      .toColorspace("srgb")
      .raw()
      .toBuffer();

    const tiles = config.doImageSplitting
      ? createSplitTiles(resizedRaw, resizedSize.width, resizedSize.height, config.imageSize)
      : [createPaddedTile(resizedRaw, resizedSize.width, resizedSize.height, config.imageSize)];

    if (config.doImageSplitting) {
      tiles.push(await createGlobalTile(this.sharpFactory, resizedRaw, resizedSize, config));
    }

    const pixelDataShape = [1, tiles.length, 3, config.imageSize, config.imageSize];
    const pixelAttentionMaskShape = [1, tiles.length, config.imageSize, config.imageSize];
    const pixelData = new Float32Array(tiles.length * 3 * config.imageSize * config.imageSize);
    const pixelAttentionMask = new Uint8Array(tiles.length * config.imageSize * config.imageSize);

    writeTilesToOutput(tiles, pixelData, pixelAttentionMask, config);

    return {
      width: resizedSize.width,
      height: resizedSize.height,
      channels: 3,
      tileCount: tiles.length,
      pixelData,
      pixelDataShape,
      pixelAttentionMask,
      pixelAttentionMaskShape,
      metadata: {
        imageProcessorType: config.imageProcessorType,
        processorClass: config.processorClass,
        imageSeqLen: config.imageSeqLen,
        imageSize: config.imageSize,
        originalSize: {
          width: originalWidth,
          height: originalHeight,
        },
        resizedSize,
        normalization: {
          doRescale: config.doRescale,
          rescaleFactor: config.rescaleFactor,
          doNormalize: config.doNormalize,
          mean: Array.from(config.imageMean),
          std: Array.from(config.imageStd),
        },
        doImageSplitting: config.doImageSplitting,
        doPad: config.doPad,
        doResize: config.doResize,
        doConvertRgb: config.doConvertRgb,
        resample: config.resample,
        sharpKernel: config.sharpKernel,
      },
    };
  }
}

async function resolvePreprocessorConfigPath(configPathOrModelPath) {
  const stat = await fs.stat(configPathOrModelPath);
  if (stat.isDirectory()) {
    return path.join(configPathOrModelPath, "preprocessor_config.json");
  }

  return configPathOrModelPath;
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path.basename(filePath)} must contain a JSON object.`);
  }

  return parsed;
}

async function readOptionalJsonFile(filePath) {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function normalizeConfig(preprocessorConfig, processorConfig) {
  const imageSize = toPositiveInteger(
    preprocessorConfig && preprocessorConfig.max_image_size && preprocessorConfig.max_image_size.longest_edge,
    DEFAULT_IMAGE_SIZE
  );
  const longestEdge = toPositiveInteger(
    preprocessorConfig && preprocessorConfig.size && preprocessorConfig.size.longest_edge,
    DEFAULT_LONGEST_EDGE
  );
  const rescaleFactor = Number.isFinite(preprocessorConfig.rescale_factor)
    ? Number(preprocessorConfig.rescale_factor)
    : DEFAULT_RESCALE_FACTOR;
  const imageMean = normalizeChannelValues(preprocessorConfig.image_mean, DEFAULT_IMAGE_MEAN);
  const imageStd = normalizeChannelValues(preprocessorConfig.image_std, DEFAULT_IMAGE_STD);
  const resample = Number.isFinite(preprocessorConfig.resample)
    ? Number(preprocessorConfig.resample)
    : 1;

  return {
    imageProcessorType: readString(preprocessorConfig.image_processor_type),
    processorClass: readString(preprocessorConfig.processor_class || processorConfig.processor_class),
    imageSeqLen: Number.isFinite(processorConfig.image_seq_len) ? Number(processorConfig.image_seq_len) : null,
    doConvertRgb: preprocessorConfig.do_convert_rgb !== false,
    doResize: preprocessorConfig.do_resize !== false,
    doImageSplitting: Boolean(preprocessorConfig.do_image_splitting),
    doPad: preprocessorConfig.do_pad !== false,
    doRescale: preprocessorConfig.do_rescale !== false,
    doNormalize: preprocessorConfig.do_normalize !== false,
    imageSize,
    longestEdge,
    rescaleFactor,
    imageMean,
    imageStd,
    resample,
    sharpKernel: mapResampleToSharpKernel(resample),
  };
}

function normalizeImageInput(input) {
  if (Buffer.isBuffer(input)) {
    return input;
  }

  if (typeof input === "string" && input.trim()) {
    return path.resolve(input);
  }

  throw new Error("processImage requires an image file path or Buffer.");
}

function calculateResizeSize(width, height, longestEdge) {
  if (width === height) {
    return { width: longestEdge, height: longestEdge };
  }

  if (width > height) {
    return {
      width: longestEdge,
      height: Math.max(1, Math.round(height * (longestEdge / width))),
    };
  }

  return {
    width: Math.max(1, Math.round(width * (longestEdge / height))),
    height: longestEdge,
  };
}

function createSplitTiles(rawRgb, width, height, imageSize) {
  const tiles = [];

  for (let top = 0; top < height; top += imageSize) {
    for (let left = 0; left < width; left += imageSize) {
      const tileWidth = Math.min(imageSize, width - left);
      const tileHeight = Math.min(imageSize, height - top);
      tiles.push(copyTile(rawRgb, width, left, top, tileWidth, tileHeight, imageSize));
    }
  }

  return tiles;
}

function createPaddedTile(rawRgb, width, height, imageSize) {
  return copyTile(rawRgb, width, 0, 0, Math.min(width, imageSize), Math.min(height, imageSize), imageSize);
}

async function createGlobalTile(sharpFactory, rawRgb, resizedSize, config) {
  const globalSize = calculateResizeSize(resizedSize.width, resizedSize.height, config.imageSize);
  const globalRaw = await sharpFactory(rawRgb, {
    raw: {
      width: resizedSize.width,
      height: resizedSize.height,
      channels: 3,
    },
  })
    .resize(globalSize.width, globalSize.height, {
      fit: "fill",
      kernel: config.sharpKernel,
    })
    .raw()
    .toBuffer();

  return createPaddedTile(globalRaw, globalSize.width, globalSize.height, config.imageSize);
}

function copyTile(rawRgb, sourceWidth, left, top, tileWidth, tileHeight, imageSize) {
  const data = Buffer.alloc(imageSize * imageSize * 3);
  const mask = new Uint8Array(imageSize * imageSize);

  for (let y = 0; y < tileHeight; y += 1) {
    const sourceStart = ((top + y) * sourceWidth + left) * 3;
    const targetStart = y * imageSize * 3;
    rawRgb.copy(data, targetStart, sourceStart, sourceStart + tileWidth * 3);
    mask.fill(1, y * imageSize, y * imageSize + tileWidth);
  }

  return {
    data,
    mask,
  };
}

function writeTilesToOutput(tiles, pixelData, pixelAttentionMask, config) {
  const imageSize = config.imageSize;
  const planeSize = imageSize * imageSize;
  const tilePixelStride = 3 * planeSize;

  for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
    const tile = tiles[tileIndex];
    pixelAttentionMask.set(tile.mask, tileIndex * planeSize);

    for (let y = 0; y < imageSize; y += 1) {
      for (let x = 0; x < imageSize; x += 1) {
        const sourceOffset = (y * imageSize + x) * 3;
        const pixelOffset = y * imageSize + x;

        for (let channel = 0; channel < 3; channel += 1) {
          const outputOffset = tileIndex * tilePixelStride + channel * planeSize + pixelOffset;
          pixelData[outputOffset] = normalizePixel(tile.data[sourceOffset + channel], channel, config);
        }
      }
    }
  }
}

function normalizePixel(value, channel, config) {
  let normalized = Number(value);

  if (config.doRescale) {
    normalized *= config.rescaleFactor;
  }

  if (config.doNormalize) {
    normalized = (normalized - config.imageMean[channel]) / config.imageStd[channel];
  }

  return normalized;
}

function mapResampleToSharpKernel(resample) {
  if (resample === 0) {
    return "nearest";
  }
  if (resample === 1) {
    return "lanczos3";
  }
  if (resample === 2) {
    return "linear";
  }
  if (resample === 3) {
    return "cubic";
  }
  return "lanczos3";
}

function normalizeChannelValues(values, fallback) {
  if (!Array.isArray(values) || values.length !== 3) {
    return Array.from(fallback);
  }

  return values.map((value, index) => Number.isFinite(value) ? Number(value) : fallback[index]);
}

function toPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function readString(value) {
  return typeof value === "string" ? value : "";
}

module.exports = {
  SmolVLMImageProcessor,
};
