const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(require("node:path").join(__dirname, "../worker.js"), "utf8");
const loadWorker = async suffix => import("data:text/javascript;base64," + Buffer.from(source).toString("base64") + "#" + suffix);
const post = async (worker, env, body) => {
  const request = new Request("https://mina.test/", {
    method: "POST",
    headers: { Origin: "https://mmp1988.github.io", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const response = await worker.default.fetch(request, env);
  return { status: response.status, data: await response.json() };
};

(async () => {
  // Gemini is the primary AI brain and receives the Persian system/user prompt.
  {
    const worker = await loadWorker("gemini-primary");
    let cloudflareCalls = 0;
    global.fetch = async (url, options) => {
      assert.match(url, /models\/gemini-3\.5-flash-lite:generateContent$/);
      assert.equal(options.headers["x-goog-api-key"], "gemini-test-key");
      const payload = JSON.parse(options.body);
      assert.ok(payload.systemInstruction?.parts?.[0]?.text);
      assert.equal(payload.contents[0].parts[0].text, "برای مشتری فردا ساعت ۱۷ نوبت ثبت کن");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ command: "برای مشتری فردا ساعت ۱۷ نوبت ثبت کن" }) }] } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const env = {
      GEMINI_API_KEY: "gemini-test-key",
      AI: { async run() { cloudflareCalls++; throw new Error("Cloudflare should not be called"); } }
    };
    const result = await post(worker, env, { mode: "understand", message: "برای مشتری فردا ساعت ۱۷ نوبت ثبت کن" });
    assert.equal(result.status, 200);
    assert.equal(result.data.success, true);
    assert.equal(cloudflareCalls, 0);
  }

  // A temporary Gemini outage should fall through to the existing Cloudflare backup.
  {
    const worker = await loadWorker("gemini-fallback");
    let cloudflareCalls = 0;
    global.fetch = async () => new Response(JSON.stringify({ error: { message: "temporary service unavailable" } }), { status: 503 });
    const env = {
      GEMINI_API_KEY: "gemini-test-key",
      AI: {
        async run(model) {
          cloudflareCalls++;
          assert.equal(model, "@cf/zai-org/glm-4.7-flash");
          return { response: JSON.stringify({ command: "برای مشتری فردا ساعت ۱۷ نوبت ثبت کن" }) };
        }
      }
    };
    const result = await post(worker, env, { mode: "understand", message: "برای مشتری فردا ساعت ۱۷ نوبت ثبت کن" });
    assert.equal(result.status, 200);
    assert.equal(result.data.success, true);
    assert.equal(cloudflareCalls, 1);
  }

  // Capacity error on the low-cost Cloudflare primary should fall through to Gemma.
  {
    const worker = await loadWorker("capacity-fallback");
    const models = [];
    global.fetch = async () => { throw new Error("Groq must not be called when Cloudflare fallback succeeds"); };
    const env = {
      GROQ_API_KEY: "test-only",
      AI: {
        async run(model) {
          models.push(model);
          if (model === "@cf/zai-org/glm-4.7-flash") throw new Error("3040 out of capacity");
          return { response: JSON.stringify({ command: "برای مشتری فردا ساعت ۱۷ نوبت ثبت کن" }) };
        }
      }
    };
    const result = await post(worker, env, { mode: "understand", message: "برای مشتری فردا ساعت ۱۷ نوبت ثبت کن" });
    assert.equal(result.status, 200);
    assert.equal(result.data.success, true);
    assert.deepEqual(models, ["@cf/zai-org/glm-4.7-flash", "@cf/google/gemma-4-26b-a4b-it"]);
  }

  // Daily Cloudflare quota exhaustion should skip its second model and use Groq Qwen.
  {
    const worker = await loadWorker("groq-fallback");
    const models = [];
    let groqCalls = 0;
    global.fetch = async (url, options) => {
      assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
      assert.match(options.headers.Authorization, /^Bearer test-only$/);
      groqCalls++;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ command: "برای مشتری فردا ساعت ۱۷ نوبت ثبت کن" }) } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const env = {
      GROQ_API_KEY: "test-only",
      AI: {
        async run(model) {
          models.push(model);
          return { success: false, errors: [{ code: 4006, message: "you have used up your daily free allocation of 10,000 neurons" }] };
        }
      }
    };
    const result = await post(worker, env, { mode: "understand", message: "برای مشتری فردا ساعت ۱۷ نوبت ثبت کن" });
    assert.equal(result.status, 200);
    assert.equal(result.data.success, true);
    assert.deepEqual(models, ["@cf/zai-org/glm-4.7-flash"]);
    assert.equal(groqCalls, 1);
  }

  // A healthy Cloudflare primary should return immediately and preserve Groq quota.
  {
    const worker = await loadWorker("cloudflare-primary");
    let groqCalls = 0;
    global.fetch = async () => { groqCalls++; throw new Error("unexpected Groq request"); };
    const env = {
      GROQ_API_KEY: "test-only",
      AI: {
        async run(model) {
          assert.equal(model, "@cf/zai-org/glm-4.7-flash");
          return { response: JSON.stringify({ command: "برای مشتری فردا ساعت ۱۷ نوبت ثبت کن" }) };
        }
      }
    };
    const result = await post(worker, env, { mode: "understand", message: "برای مشتری فردا ساعت ۱۷ نوبت ثبت کن" });
    assert.equal(result.status, 200);
    assert.equal(result.data.success, true);
    assert.equal(groqCalls, 0);
  }

  console.log("Worker AI provider failover: PASS");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
