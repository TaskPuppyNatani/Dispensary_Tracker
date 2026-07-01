"use strict";

const fs = require("fs/promises");
const path = require("path");

const REQUIRED_TOKENIZER_FILES = Object.freeze([
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "added_tokens.json",
  "chat_template.json",
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
    const chatTemplate = readString(chatTemplateConfig.chat_template);

    if (!chatTemplate) {
      throw new Error("chat_template.json is missing chat_template.");
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
    this.specialTokens = buildSpecialTokens(tokenizer, specialTokensMap, addedTokens);
    this.warnings = warnings;

    return {
      loaded: true,
      modelPath: this.modelPath,
      chatTemplateLoaded: Boolean(this.chatTemplate),
      tokenizerLoaded: Boolean(this.tokenizer),
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

    const prompt = typeof messages === "string"
      ? messages
      : this.formatChat(messages, options);
    const inputIds = this.tokenizer.encode(prompt);

    return {
      inputIds: Array.from(inputIds),
      tokenCount: inputIds.length,
      specialTokens: this.getSpecialTokens(),
      prompt,
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

function readString(value) {
  return typeof value === "string" ? value : "";
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  SmolVLMTokenizer,
};
