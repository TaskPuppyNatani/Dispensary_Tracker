"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  OpenAICompatibleReceiptVisionProvider,
  RECEIPT_EXTRACTION_PROMPT,
  deriveModelsUrl,
} = require("./local-ai/OpenAICompatibleReceiptVisionProvider.js");

function makeReceipt(overrides) {
  return Object.assign({
    dispensary: "Green Valley",
    license_number: "LIC-123",
    receipt_number: "R-100",
    purchase_date: "2026-07-02",
    purchase_time: "10:30 AM",
    subtotal: 42.5,
    tax: 4.2,
    total: 46.7,
    payment_method: "cash",
    budtender: null,
    discounts: [],
    products: [],
  }, overrides || {});
}

function createResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function createFetchMock(handler) {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    calls.push({ url, options });
    return await handler(url, options, calls.length);
  };
  fetchMock.calls = calls;
  return fetchMock;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function run() {
  const summaries = [];

  async function test(name, fn) {
    await fn();
    summaries.push(name);
  }

  await test("derives models endpoint from chat completions URL", async function() {
    assert.strictEqual(
      deriveModelsUrl("http://localhost:1234/v1/chat/completions"),
      "http://localhost:1234/v1/models"
    );
  });

  await test("sends image data URL and prompt to chat completions", async function() {
    const receipt = makeReceipt();
    const returnedText = JSON.stringify(receipt);
    const fetchMock = createFetchMock(async (url, options, callNumber) => {
      if (callNumber === 1) {
        return createResponse({
          data: [{ id: "qwen-test-model" }],
        });
      }

      assert.strictEqual(url, "http://localhost:1234/v1/chat/completions");
      assert.strictEqual(options.method, "POST");

      const body = JSON.parse(options.body);
      assert.strictEqual(body.model, "qwen-test-model");
      assert.strictEqual(body.max_tokens, 128);
      assert.strictEqual(body.temperature, 0);
      assert.strictEqual(body.messages[0].role, "user");
      assert.strictEqual(body.messages[0].content[0].type, "text");
      assert.strictEqual(body.messages[0].content[0].text, RECEIPT_EXTRACTION_PROMPT);
      assert.strictEqual(body.messages[0].content[1].type, "image_url");
      assert.ok(body.messages[0].content[1].image_url.url.startsWith("data:image/jpeg;base64,"));
      assert.strictEqual(
        body.messages[0].content[1].image_url.url,
        `data:image/jpeg;base64,${Buffer.from("receipt-image").toString("base64")}`
      );

      return createResponse({
        choices: [
          {
            message: {
              content: returnedText,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          completion_tokens: 42,
        },
      });
    });

    const provider = new OpenAICompatibleReceiptVisionProvider({
      fetch: fetchMock,
      model: "qwen-test-model",
      temperature: 0,
    });

    await provider.initialize();
    const result = await provider.analyzeReceipt({
      imageBuffer: Buffer.from("receipt-image"),
      maxNewTokens: 128,
      stopTokenIds: [123],
    });

    assert.strictEqual(fetchMock.calls.length, 2);
    assert.strictEqual(result.text, returnedText);
    assert.deepStrictEqual(result.receipt, {
      dispensary: "Green Valley",
      licenseNumber: "LIC-123",
      receiptNumber: "R-100",
      purchaseDate: "2026-07-02",
      purchaseTime: "10:30 AM",
      subtotal: 42.5,
      tax: 4.2,
      total: 46.7,
      paymentMethod: "cash",
      budtender: null,
      discounts: [],
      loyalty: null,
      products: [],
    });
    assert.strictEqual(result.pipeline.validation.validation.valid, true);
    assert.strictEqual(result.metadata.providerName, "OpenAICompatibleReceiptVisionProvider");
    assert.strictEqual(result.metadata.backend, "openai-compatible");
    assert.strictEqual(result.metadata.modelId, "qwen-test-model");
    assert.strictEqual(result.metadata.generation.generatedTokenCount, 42);
    assert.strictEqual(result.metadata.generationSettings.maxNewTokens, 128);
    assert.deepStrictEqual(result.metadata.generationSettings.stopTokenIds, [123]);
    assert.strictEqual(result.metadata.request.stopTokenIdsApplied, false);
  });

  await test("includes deterministic OCR context in prompt and metadata", async function() {
    const receipt = makeReceipt();
    const fetchMock = createFetchMock(async (url, options, callNumber) => {
      if (callNumber === 1) {
        return createResponse({
          data: [{ id: "qwen-test-model" }],
        });
      }

      const body = JSON.parse(options.body);
      assert.strictEqual(body.messages[0].content.length, 3);
      assert.strictEqual(body.messages[0].content[0].type, "text");
      assert.ok(body.messages[0].content[0].text.includes("The following OCR values were extracted deterministically from the receipt."));
      assert.ok(body.messages[0].content[0].text.includes("\"dispensary\": \"Green Valley\""));
      assert.ok(body.messages[0].content[0].text.includes("\"ocrContext\": {"));
      assert.strictEqual(body.messages[0].content[1].type, "text");
      assert.strictEqual(body.messages[0].content[1].text, RECEIPT_EXTRACTION_PROMPT);
      assert.strictEqual(body.messages[0].content[2].type, "image_url");

      return createResponse({
        choices: [
          {
            message: {
              content: JSON.stringify(receipt),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          completion_tokens: 11,
        },
      });
    });

    const provider = new OpenAICompatibleReceiptVisionProvider({
      fetch: fetchMock,
      model: "qwen-test-model",
    });

    await provider.initialize();
    const result = await provider.analyzeReceipt({
      imageBuffer: Buffer.from("receipt-image"),
      deterministicContext: {
        dispensary: "Green Valley",
        license_number: "LIC-123",
        purchase_date: "2026-07-02",
        purchase_time: "10:30 AM",
        subtotal: null,
        tax: null,
        total: 46.7,
        phone: "5035551212",
        address: "123 Main St, Portland, OR 97201",
        rawOcrText: "Green Valley 123 Main St",
      },
      ocrContext: {
        provided: true,
        fieldCount: 5,
        rawTextLength: 24,
      },
    });

    assert.strictEqual(result.metadata.ocrContext.provided, true);
    assert.strictEqual(result.metadata.ocrContext.fieldCount, 5);
    assert.strictEqual(result.metadata.ocrContext.rawTextLength, 24);
    assert.strictEqual(result.metadata.generation.generatedTokenCount, 11);
  });

  await test("uses provider default max tokens when not overridden", async function() {
    const receipt = makeReceipt();
    const fetchMock = createFetchMock(async (url, options, callNumber) => {
      if (callNumber === 1) {
        return createResponse({
          data: [{ id: "qwen-test-model" }],
        });
      }

      const body = JSON.parse(options.body);
      assert.strictEqual(body.max_tokens, 2048);

      return createResponse({
        choices: [
          {
            message: {
              content: JSON.stringify(receipt),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          completion_tokens: 7,
        },
      });
    });

    const provider = new OpenAICompatibleReceiptVisionProvider({
      fetch: fetchMock,
      model: "qwen-test-model",
    });

    await provider.initialize();
    const result = await provider.analyzeReceipt({
      imageBuffer: Buffer.from("receipt-image"),
    });

    assert.strictEqual(result.metadata.generationSettings.maxNewTokens, 2048);
    assert.strictEqual(result.metadata.request.maxTokens, 2048);
    assert.strictEqual(result.metadata.generation.stoppedBy, "stop");
  });

  await test("uses first reported model when no model is configured", async function() {
    const fetchMock = createFetchMock(async () => createResponse({
      data: [{ id: "first-model" }, { id: "second-model" }],
    }));
    const provider = new OpenAICompatibleReceiptVisionProvider({ fetch: fetchMock, model: "" });
    const status = await provider.initialize();

    assert.strictEqual(status.modelId, "first-model");
    assert.strictEqual(status.healthStatus.available, true);
    assert.deepStrictEqual(status.healthStatus.warnings, [
      "No OpenAI-compatible model was configured; using the first model reported by the server."
    ]);
  });

  await test("health check reports unavailable when configured model is missing", async function() {
    const fetchMock = createFetchMock(async () => createResponse({
      data: [{ id: "different-model" }],
    }));
    const provider = new OpenAICompatibleReceiptVisionProvider({
      fetch: fetchMock,
      model: "missing-model",
    });
    const health = await provider.getHealthStatus();

    assert.strictEqual(health.available, false);
    assert.strictEqual(health.reason, "configured_model_not_reported_by_server");
    assert.deepStrictEqual(health.models, ["different-model"]);
  });

  await test("health check reports unavailable when server cannot be reached", async function() {
    const fetchMock = createFetchMock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const provider = new OpenAICompatibleReceiptVisionProvider({ fetch: fetchMock });
    const health = await provider.getHealthStatus();

    assert.strictEqual(health.available, false);
    assert.strictEqual(health.reason, "ECONNREFUSED");
  });

  await test("malformed chat response throws clear error", async function() {
    const fetchMock = createFetchMock(async (url, options, callNumber) => {
      if (callNumber === 1) {
        return createResponse({ data: [{ id: "qwen-test-model" }] });
      }
      return createResponse({ choices: [{ message: { content: "" } }] });
    });
    const provider = new OpenAICompatibleReceiptVisionProvider({
      fetch: fetchMock,
      model: "qwen-test-model",
    });

    await provider.initialize();
    await assert.rejects(
      () => provider.analyzeReceipt({ imageBuffer: Buffer.from("receipt-image") }),
      /did not include assistant text/
    );
  });

  await test("analysis input metadata is not mutated", async function() {
    const receipt = makeReceipt();
    const fetchMock = createFetchMock(async (url, options, callNumber) => {
      if (callNumber === 1) {
        return createResponse({ data: [{ id: "qwen-test-model" }] });
      }
      return createResponse({
        choices: [{ message: { content: JSON.stringify(receipt) }, finish_reason: "stop" }],
      });
    });
    const provider = new OpenAICompatibleReceiptVisionProvider({
      fetch: fetchMock,
      model: "qwen-test-model",
    });
    const input = {
      imageBuffer: Buffer.from("receipt-image"),
      maxNewTokens: 64,
      stopTokenIds: [9],
    };
    const before = clone({
      imageBuffer: Array.from(input.imageBuffer),
      maxNewTokens: input.maxNewTokens,
      stopTokenIds: input.stopTokenIds,
    });

    await provider.initialize();
    await provider.analyzeReceipt(input);

    assert.deepStrictEqual({
      imageBuffer: Array.from(input.imageBuffer),
      maxNewTokens: input.maxNewTokens,
      stopTokenIds: input.stopTokenIds,
    }, before);
  });

  await test("static import check", async function() {
    const providerPath = path.join(__dirname, "local-ai", "OpenAICompatibleReceiptVisionProvider.js");
    const source = fs.readFileSync(providerPath, "utf8");
    const requires = Array.from(source.matchAll(/require\("([^"]+)"\)/g)).map((match) => match[1]).sort();

    assert.deepStrictEqual(requires, [
      "./ReceiptExtractionPrompt.js",
      "./ReceiptProcessingPipeline.js",
    ].sort());

    const forbidden = [
      "OnnxVisionRuntime",
      "SmolVLMTokenizer",
      "SmolVLMImageProcessor",
      "SmolVLMModelAdapter",
      "ReceiptJsonValidator",
      "ReceiptObjectMapper",
      "indexedDB",
      "localStorage",
      "document.",
    ];

    for (const term of forbidden) {
      assert.strictEqual(source.includes(term), false, `provider should not reference ${term}`);
    }
  });

  await test("shared prompt is production JSON prompt", async function() {
    assert.ok(RECEIPT_EXTRACTION_PROMPT.includes("Return ONLY a single valid JSON object."));
    assert.ok(RECEIPT_EXTRACTION_PROMPT.includes('"dispensary": string|null'));
    assert.ok(RECEIPT_EXTRACTION_PROMPT.includes("Never infer payment method"));
    assert.strictEqual(RECEIPT_EXTRACTION_PROMPT.includes("receipt-reading diagnostic test"), false);
    assert.strictEqual(RECEIPT_EXTRACTION_PROMPT.includes("Return a human-readable bullet list"), false);
  });

  console.log(`ALL TESTS PASSED (${summaries.length})`);
  console.log("OpenAI-compatible provider summaries:");
  for (const summary of summaries) {
    console.log(`- ${summary}`);
  }
}

run().catch((error) => {
  console.error("TESTS FAILED:", error && error.stack ? error.stack : error);
  process.exit(1);
});
