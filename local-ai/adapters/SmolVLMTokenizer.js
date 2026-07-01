"use strict";

const fs = require("fs/promises");
const path = require("path");

const REQUIRED_TOKENIZER_FILES = Object.freeze([
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "added_tokens.json",
  "chat_template.json",
  "processor_config.json",
]);

class SmolVLMTokenizer {
  constructor() {
    this.modelPath = "";
    this.tokenizer = null;
    this.transformers = null;
    this.chatTemplate = "";
    this.tokenizerConfig = null;
    this.specialTokensMap = null;
    this.addedTokens = null;
    this.processorConfig = null;
    this.imageSeqLen = null;
    this.specialTokens = null;
    this.warnings = [];
  }

  async load(modelPath) {
    const resolvedModelPath = path.resolve(String(modelPath || ""));
    const warnings = [];

    await validateTokenizerFiles(resolvedModelPath);

    const tokenizerConfig = await readJsonFile(path.join(resolvedModelPath, "tokenizer_config.json"));
    const specialTokensMap = await readJsonFile(path.join(resolvedModelPath, "special_tokens_map.json"));
    const addedTokens = await readJsonFile(path.join(resolvedModelPath, "added_tokens.json"));
    const chatTemplateConfig = await readJsonFile(path.join(resolvedModelPath, "chat_template.json"));
    const processorConfig = await readJsonFile(path.join(resolvedModelPath, "processor_config.json"));
    const chatTemplate = readString(chatTemplateConfig.chat_template);
    const imageSeqLen = readPositiveInteger(processorConfig.image_seq_len, 0);

    if (!chatTemplate) {
      throw new Error("chat_template.json is missing chat_template.");
    }

    if (!imageSeqLen) {
      throw new Error("processor_config.json is missing image_seq_len.");
    }

    const tokenizerConfigTemplate = readString(tokenizerConfig.chat_template);
    if (tokenizerConfigTemplate && tokenizerConfigTemplate !== chatTemplate) {
      warnings.push("chat_template.json differs from tokenizer_config.json; using chat_template.json.");
    }

    const transformers = await loadTransformersForLocalUse();
    const tokenizer = await transformers.AutoTokenizer.from_pretrained(resolvedModelPath, {
      local_files_only: true,
    });

    if (!tokenizer || typeof tokenizer.encode !== "function" || typeof tokenizer.decode !== "function") {
      throw new Error("Transformers.js tokenizer did not expose encode/decode methods.");
    }

    if (typeof tokenizer.apply_chat_template !== "function") {
      throw new Error("Transformers.js tokenizer did not expose apply_chat_template.");
    }

    tokenizer.chat_template = chatTemplate;

    this.modelPath = resolvedModelPath;
    this.tokenizer = tokenizer;
    this.transformers = transformers;
    this.chatTemplate = chatTemplate;
    this.tokenizerConfig = tokenizerConfig;
    this.specialTokensMap = specialTokensMap;
    this.addedTokens = addedTokens;
    this.processorConfig = processorConfig;
    this.imageSeqLen = imageSeqLen;
    this.specialTokens = buildSpecialTokens(tokenizer, specialTokensMap, addedTokens);
    this.warnings = warnings;

    return {
      loaded: true,
      modelPath: this.modelPath,
      chatTemplateLoaded: Boolean(this.chatTemplate),
      tokenizerLoaded: Boolean(this.tokenizer),
      imageSeqLen: this.imageSeqLen,
      specialTokens: this.getSpecialTokens(),
      warnings: Array.from(this.warnings),
    };
  }

  formatChat(messages, options = {}) {
    this._assertLoaded();
    validateMessages(messages);

    return this.tokenizer.apply_chat_template(messages, {
      tokenize: false,
      add_generation_prompt: options.addGenerationPrompt !== false,
    });
  }

  encode(messages, options = {}) {
    this._assertLoaded();

    const unexpandedPrompt = typeof messages === "string"
      ? messages
      : this.formatChat(messages, options);
    const expansion = options.expandImages === false
      ? createUnexpandedMetadata(unexpandedPrompt, this)
      : expandPromptWithImageTokens(unexpandedPrompt, options, this);
    const prompt = expansion.prompt;
    const inputIds = this.tokenizer.encode(prompt);
    const replaceableImageTokenIndices = findTokenIndices(inputIds, this.specialTokens.image.id);

    if (expansion.expanded) {
      validateReplacementIndices(inputIds, replaceableImageTokenIndices, this.specialTokens.image.id, expansion.replaceableImageTokenCount);
    }

    return {
      inputIds: Array.from(inputIds),
      tokenCount: inputIds.length,
      specialTokens: this.getSpecialTokens(),
      prompt,
      unexpandedPrompt,
      expansion: {
        expanded: expansion.expanded,
        imageSeqLen: expansion.imageSeqLen,
        imageTokenId: expansion.imageTokenId,
        replaceableImageTokenCount: expansion.expanded ? expansion.replaceableImageTokenCount : 0,
        imageFeatureBlockCount: expansion.expanded ? expansion.imageFeatureBlockCount : 0,
        imageLayouts: expansion.expanded ? expansion.imageLayouts : [],
        replaceableImageTokenIndices: expansion.expanded ? replaceableImageTokenIndices : [],
      },
    };
  }

  decode(tokenIds, options = {}) {
    this._assertLoaded();

    if (!Array.isArray(tokenIds) && !(ArrayBuffer.isView(tokenIds))) {
      throw new Error("decode requires an array or typed array of token IDs.");
    }

    return this.tokenizer.decode(Array.from(tokenIds), {
      skip_special_tokens: options.skipSpecialTokens === true,
    });
  }

  getSpecialTokens() {
    return this.specialTokens ? cloneSerializable(this.specialTokens) : {};
  }

  _assertLoaded() {
    if (!this.tokenizer) {
      throw new Error("SmolVLMTokenizer must be loaded before use.");
    }
  }
}

function expandPromptWithImageTokens(prompt, options, context) {
  const imageToken = getRequiredSpecialToken(context.specialTokens, "image");
  const fakeImageToken = getRequiredSpecialToken(context.specialTokens, "fakeImage");
  const globalImageToken = getRequiredSpecialToken(context.specialTokens, "globalImage");
  const imageTokenId = getRequiredSpecialTokenId(context.specialTokens, "image");
  const imageSeqLen = context.imageSeqLen;
  const placeholderCount = countOccurrences(prompt, imageToken);
  const imageLayouts = normalizeImageLayouts(options, placeholderCount);
  let imageFeatureBlockCount = 0;
  let replaceableImageTokenCount = 0;

  if (placeholderCount === 0) {
    return {
      prompt,
      expanded: true,
      imageSeqLen,
      imageTokenId,
      replaceableImageTokenCount,
      imageFeatureBlockCount,
      imageLayouts,
    };
  }

  const promptParts = prompt.split(imageToken);
  let expandedPrompt = promptParts[0];

  for (let index = 0; index < placeholderCount; index += 1) {
    const layout = imageLayouts[index];
    const replacement = createImagePromptReplacement(layout, {
      imageSeqLen,
      imageToken,
      fakeImageToken,
      globalImageToken,
      addedTokens: context.addedTokens,
    });

    imageFeatureBlockCount += replacement.imageFeatureBlockCount;
    replaceableImageTokenCount += replacement.replaceableImageTokenCount;
    expandedPrompt += replacement.prompt + promptParts[index + 1];
  }

  return {
    prompt: expandedPrompt,
    expanded: true,
    imageSeqLen,
    imageTokenId,
    replaceableImageTokenCount,
    imageFeatureBlockCount,
    imageLayouts,
  };
}

function createImagePromptReplacement(layout, options) {
  if (layout.rows === 0 && layout.cols === 0) {
    return {
      prompt: options.fakeImageToken
        + options.globalImageToken
        + options.imageToken.repeat(options.imageSeqLen)
        + options.fakeImageToken,
      replaceableImageTokenCount: options.imageSeqLen,
      imageFeatureBlockCount: 1,
    };
  }

  let prompt = "";
  let imageFeatureBlockCount = 0;

  for (let row = 1; row <= layout.rows; row += 1) {
    for (let col = 1; col <= layout.cols; col += 1) {
      prompt += options.fakeImageToken
        + getRowColToken(row, col, options.addedTokens)
        + options.imageToken.repeat(options.imageSeqLen);
      imageFeatureBlockCount += 1;
    }
    prompt += "\n";
  }

  prompt += "\n"
    + options.fakeImageToken
    + options.globalImageToken
    + options.imageToken.repeat(options.imageSeqLen)
    + options.fakeImageToken;
  imageFeatureBlockCount += 1;

  return {
    prompt,
    replaceableImageTokenCount: imageFeatureBlockCount * options.imageSeqLen,
    imageFeatureBlockCount,
  };
}

function normalizeImageLayouts(options, placeholderCount) {
  const rawLayouts = readImageLayouts(options);

  if (rawLayouts.length > 0 && rawLayouts.length !== placeholderCount) {
    throw new Error(
      `Expected ${placeholderCount} image layout(s), received ${rawLayouts.length}.`
    );
  }

  const layouts = rawLayouts.length > 0
    ? rawLayouts
    : Array.from({ length: placeholderCount }, () => ({ rows: 0, cols: 0 }));

  return layouts.map((layout, index) => normalizeImageLayout(layout, index));
}

function readImageLayouts(options) {
  if (Array.isArray(options.imageLayouts)) {
    return options.imageLayouts;
  }

  if (options.imageLayout) {
    return [options.imageLayout];
  }

  return [];
}

function normalizeImageLayout(layout, index) {
  if (!layout || typeof layout !== "object") {
    throw new Error(`imageLayouts[${index}] must be an object.`);
  }

  const rows = readNonNegativeInteger(layout.rows, `imageLayouts[${index}].rows`);
  const cols = readNonNegativeInteger(layout.cols, `imageLayouts[${index}].cols`);

  if ((rows === 0 && cols > 0) || (rows > 0 && cols === 0)) {
    throw new Error(`imageLayouts[${index}] must set both rows and cols, or neither.`);
  }

  return { rows, cols };
}

function createUnexpandedMetadata(prompt, context) {
  return {
    prompt,
    expanded: false,
    imageSeqLen: context.imageSeqLen,
    imageTokenId: getRequiredSpecialTokenId(context.specialTokens, "image"),
    replaceableImageTokenCount: 0,
    imageFeatureBlockCount: 0,
    imageLayouts: [],
  };
}

function getRequiredSpecialToken(specialTokens, key) {
  const token = specialTokens && specialTokens[key] && readString(specialTokens[key].content);
  if (!token) {
    throw new Error(`Missing required special token: ${key}.`);
  }
  return token;
}

function getRequiredSpecialTokenId(specialTokens, key) {
  const id = specialTokens && specialTokens[key] && specialTokens[key].id;
  if (!Number.isSafeInteger(id)) {
    throw new Error(`Missing required special token ID: ${key}.`);
  }
  return id;
}

function getRowColToken(row, col, addedTokens) {
  const token = `<row_${row}_col_${col}>`;
  if (!Number.isSafeInteger(addedTokens[token])) {
    throw new Error(`Missing local row/column token: ${token}.`);
  }
  return token;
}

function countOccurrences(value, needle) {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let index = value.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(needle, index + needle.length);
  }
  return count;
}

function findTokenIndices(inputIds, tokenId) {
  const indices = [];
  for (let index = 0; index < inputIds.length; index += 1) {
    if (inputIds[index] === tokenId) {
      indices.push(index);
    }
  }
  return indices;
}

function validateReplacementIndices(inputIds, indices, imageTokenId, expectedCount) {
  if (indices.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} replaceable image token(s), found ${indices.length}.`
    );
  }

  for (let index = 0; index < indices.length; index += 1) {
    const tokenIndex = indices[index];
    if (index > 0 && tokenIndex <= indices[index - 1]) {
      throw new Error("replaceableImageTokenIndices must be strictly increasing.");
    }
    if (inputIds[tokenIndex] !== imageTokenId) {
      throw new Error(`replaceableImageTokenIndices[${index}] does not point to the image token ID.`);
    }
  }
}

async function loadTransformersForLocalUse() {
  const transformers = await import("@huggingface/transformers");

  if (!transformers || !transformers.env || !transformers.AutoTokenizer) {
    throw new Error("Could not load Transformers.js tokenizer APIs.");
  }

  transformers.env.allowRemoteModels = false;
  transformers.env.allowLocalModels = true;
  transformers.env.useBrowserCache = false;
  transformers.env.useFSCache = false;

  return transformers;
}

async function validateTokenizerFiles(modelPath) {
  const stat = await fs.stat(modelPath);
  if (!stat.isDirectory()) {
    throw new Error("Tokenizer model path must be a directory.");
  }

  const missingFiles = [];
  for (const fileName of REQUIRED_TOKENIZER_FILES) {
    try {
      const fileStat = await fs.stat(path.join(modelPath, fileName));
      if (!fileStat.isFile()) {
        missingFiles.push(fileName);
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        missingFiles.push(fileName);
        continue;
      }
      throw error;
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(`Missing tokenizer file(s): ${missingFiles.join(", ")}.`);
  }
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path.basename(filePath)} must contain a JSON object.`);
  }

  return parsed;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("formatChat requires at least one message.");
  }

  for (const [messageIndex, message] of messages.entries()) {
    if (!message || typeof message !== "object") {
      throw new Error(`messages[${messageIndex}] must be an object.`);
    }

    if (!readString(message.role)) {
      throw new Error(`messages[${messageIndex}].role is required.`);
    }

    if (!Array.isArray(message.content) || message.content.length === 0) {
      throw new Error(`messages[${messageIndex}].content must be a non-empty array.`);
    }

    for (const [contentIndex, content] of message.content.entries()) {
      if (!content || typeof content !== "object") {
        throw new Error(`messages[${messageIndex}].content[${contentIndex}] must be an object.`);
      }

      if (content.type === "text" && typeof content.text !== "string") {
        throw new Error(`messages[${messageIndex}].content[${contentIndex}].text must be a string.`);
      }

      if (content.type !== "text" && content.type !== "image") {
        throw new Error(`Unsupported content type: ${String(content.type || "")}.`);
      }
    }
  }
}

function buildSpecialTokens(tokenizer, specialTokensMap, addedTokens) {
  const tokens = {
    bos: tokenWithId(tokenizer, readTokenValue(specialTokensMap.bos_token), addedTokens),
    eos: tokenWithId(tokenizer, readTokenValue(specialTokensMap.eos_token), addedTokens),
    pad: tokenWithId(tokenizer, readTokenValue(specialTokensMap.pad_token), addedTokens),
    unk: tokenWithId(tokenizer, readTokenValue(specialTokensMap.unk_token), addedTokens),
    image: tokenWithId(tokenizer, readTokenValue(specialTokensMap.image_token), addedTokens),
    fakeImage: tokenWithId(tokenizer, readTokenValue(specialTokensMap.fake_image_token), addedTokens),
    globalImage: tokenWithId(tokenizer, readTokenValue(specialTokensMap.global_image_token), addedTokens),
    endOfUtterance: tokenWithId(tokenizer, readTokenValue(specialTokensMap.end_of_utterance_token), addedTokens),
    additionalSpecialTokens: [],
  };

  if (Array.isArray(specialTokensMap.additional_special_tokens)) {
    tokens.additionalSpecialTokens = specialTokensMap.additional_special_tokens
      .map((token) => tokenWithId(tokenizer, readTokenValue(token), addedTokens))
      .filter((token) => token.content);
  }

  return tokens;
}

function tokenWithId(tokenizer, content, addedTokens) {
  const token = readString(content);

  return {
    content: token,
    id: token ? resolveTokenId(tokenizer, token, addedTokens) : null,
  };
}

function resolveTokenId(tokenizer, token, addedTokens) {
  if (Number.isSafeInteger(addedTokens[token])) {
    return addedTokens[token];
  }

  if (typeof tokenizer.convert_tokens_to_ids === "function") {
    const id = tokenizer.convert_tokens_to_ids(token);
    if (Number.isSafeInteger(id)) {
      return id;
    }
  }

  return null;
}

function readTokenValue(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object" && typeof value.content === "string") {
    return value.content;
  }

  return "";
}

function readPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function readNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return number;
}

function readString(value) {
  return typeof value === "string" ? value : "";
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  SmolVLMTokenizer,
};
