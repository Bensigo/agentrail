// Deterministic executor for a server-resolved, persisted UI criterion. It
// deliberately has no model loop: it can only replay the bounded plan below.

export const REQUIRED_BROWSER_TOOLS = [
  "agent_browser_open",
  "agent_browser_click",
  "agent_browser_fill",
  "agent_browser_press",
  "agent_browser_wait_for_text",
  "agent_browser_get_url",
  "agent_browser_screenshot",
  "agent_browser_close",
];

const MAX_STEPS = 12;
const MAX_TEXT = 2_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const PRESS_KEYS = new Set([
  "Enter", "Tab", "Escape", "Space", "Backspace",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

class NotTestableError extends Error {}
class NotProvenError extends Error {}

function degraded(state) {
  return { ok: false, degraded: true, state };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, allowEmpty = false) {
  if (typeof value !== "string" || value.length > MAX_TEXT || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const text = value.trim();
  return allowEmpty || text ? text : null;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function previewOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new NotTestableError();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new NotTestableError();
  }
  return url.origin;
}

function safeRelativePath(path) {
  const value = boundedText(path);
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return null;
  }
  return value;
}

function safeOpenUrl(path, origin) {
  const value = safeRelativePath(path);
  if (!value) throw new NotProvenError();
  let url;
  try {
    url = new URL(value, origin);
  } catch {
    throw new NotProvenError();
  }
  if (url.origin !== origin || url.username || url.password) throw new NotProvenError();
  return url.toString();
}

function validateStep(raw, index, length) {
  if (!object(raw)) throw new NotTestableError();
  const action = raw.action;
  const schema = {
    open: ["action", "path"],
    click: ["action", "selector"],
    fill: ["action", "selector", "value"],
    press: ["action", "key"],
    expect_text: ["action", "text"],
    screenshot: ["action", "label"],
  }[action];
  if (!schema || !exactKeys(raw, schema)) {
    throw new NotTestableError();
  }
  if (
    (action === "open" && (!safeRelativePath(raw.path) || raw.path !== boundedText(raw.path))) ||
    (action === "click" && !boundedText(raw.selector)) ||
    (action === "fill" && (!boundedText(raw.selector) || boundedText(raw.value, true) === null)) ||
    (action === "press" && !PRESS_KEYS.has(raw.key)) ||
    (action === "expect_text" && !boundedText(raw.text)) ||
    (action === "screenshot" && !boundedText(raw.label))
  ) throw new NotTestableError();
  if (index === 0 && action !== "open") throw new NotTestableError();
  if (index === length - 2 && action !== "expect_text") throw new NotTestableError();
  if (index === length - 1 && action !== "screenshot") throw new NotTestableError();
  if (index > 0 && index < length - 2 && !["click", "fill", "press"].includes(action)) {
    throw new NotTestableError();
  }
  return raw;
}

function validateContext(raw) {
  if (!object(raw)) throw new NotTestableError();
  if (!exactKeys(raw, [
    "executionId", "jobId", "criterionId", "expected", "previewBootId", "previewUrl", "uiSteps",
  ])) throw new NotTestableError();
  const executionId = boundedText(raw.executionId);
  const jobId = boundedText(raw.jobId);
  const criterionId = boundedText(raw.criterionId);
  const expected = boundedText(raw.expected);
  const previewBootId = boundedText(raw.previewBootId);
  const previewUrl = boundedText(raw.previewUrl);
  if (!executionId || !jobId || !criterionId || !expected || !previewBootId || !previewUrl || !Array.isArray(raw.uiSteps)) {
    throw new NotTestableError();
  }
  if (raw.uiSteps.length < 3 || raw.uiSteps.length > MAX_STEPS) throw new NotTestableError();
  const steps = raw.uiSteps.map((step, index) => validateStep(step, index, raw.uiSteps.length));
  return { executionId, jobId, criterionId, expected, previewBootId, previewUrl, steps };
}

function textResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  if (content.length !== 1 || content[0]?.type !== "text") return null;
  return boundedText(content[0].text);
}

function screenshotResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  // agent-browser 0.31.1 returns a text path plus the image block. Ignore
  // textual metadata, but require exactly one decisive image so multiple or
  // ambiguous screenshots can never be silently selected.
  const images = content.filter((item) => item?.type === "image");
  if (images.length !== 1) return null;
  const image = images[0];
  const base64 = typeof image?.data === "string" ? image.data.trim() : "";
  if (
    image?.type !== "image" ||
    !["image/png", "image/jpeg"].includes(image.mimeType) ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  ) {
    return null;
  }
  return { imageBase64: base64, contentType: image.mimeType };
}

function samePreviewUrl(value, origin) {
  const text = textResult(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.origin === origin && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function validAttestedReceipt(value, { context, assertionPassed }) {
  if (
    !object(value) ||
    !exactKeys(value, [
      "ok", "state", "expected", "observed", "evidenceRef", "evidenceKey", "evidenceUrl",
    ]) ||
    value.ok !== true ||
    value.state !== (assertionPassed ? "proven" : "failed") ||
    value.expected !== context.expected ||
    value.evidenceRef !== `review-ui-execution:${context.executionId}` ||
    !boundedText(value.observed) ||
    !boundedText(value.evidenceKey)
  ) return false;
  try {
    const evidenceUrl = new URL(String(value.evidenceUrl));
    return (
      (evidenceUrl.protocol === "http:" || evidenceUrl.protocol === "https:") &&
      !evidenceUrl.username &&
      !evidenceUrl.password
    );
  } catch {
    return false;
  }
}

async function settleBounded(action, closeTimeoutMs) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action).catch(() => undefined),
      new Promise((resolve) => { timer = setTimeout(resolve, closeTimeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeBounded(client, session, closeTimeoutMs) {
  if (session && typeof client.callTool === "function") {
    await settleBounded(
      () => client.callTool({
        name: "agent_browser_close",
        arguments: { session },
      }),
      closeTimeoutMs,
    );
  }
  await settleBounded(() => client.close(), closeTimeoutMs);
}

/**
 * Replay one closed UI plan through an isolated browser-MCP session. All
 * failures are deliberately reduced to stable, non-diagnostic degraded states.
 */
export function createReviewUiExecutor({
  createClient,
  completeExecution,
  makeSessionId = ({ executionId }) => `jace-review-ui-${executionId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 96)}`,
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
}) {
  if (typeof createClient !== "function") throw new TypeError("createClient is required");
  if (typeof completeExecution !== "function") throw new TypeError("completeExecution is required");
  if (typeof makeSessionId !== "function") throw new TypeError("makeSessionId must be a function");
  if (!Number.isInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 30_000) {
    throw new TypeError("closeTimeoutMs must be an integer between 1 and 30000");
  }

  return async function execute(rawContext) {
    let client;
    let browserSession;
    try {
      const context = validateContext(rawContext);
      const origin = previewOrigin(context.previewUrl);
      const session = boundedText(makeSessionId({ executionId: context.executionId }));
      if (!session) throw new NotTestableError();
      browserSession = session;

      try {
        client = await createClient({ session });
        if (!client || typeof client.connect !== "function" || typeof client.listTools !== "function" || typeof client.callTool !== "function" || typeof client.close !== "function") {
          throw new NotTestableError();
        }
        await client.connect();
      } catch (error) {
        if (error instanceof NotTestableError) throw error;
        throw new NotTestableError();
      }

      let declared;
      try {
        declared = await client.listTools();
      } catch {
        throw new NotTestableError();
      }
      const names = new Set((Array.isArray(declared?.tools) ? declared.tools : []).map((tool) => tool?.name));
      if (REQUIRED_BROWSER_TOOLS.some((name) => !names.has(name))) throw new NotTestableError();

      const call = async (name, args) => {
        let result;
        try {
          result = await client.callTool({ name, arguments: { ...args, session } });
        } catch {
          throw new NotProvenError();
        }
        return result;
      };

      const currentPreviewUrl = async () => {
        const response = await call("agent_browser_get_url", {});
        if (response?.isError) throw new NotProvenError();
        const url = samePreviewUrl(response, origin);
        if (!url) throw new NotProvenError();
        return url;
      };

      for (const step of context.steps.slice(0, -2)) {
        let response;
        if (step.action === "open") response = await call("agent_browser_open", { url: safeOpenUrl(step.path, origin) });
        if (step.action === "click") response = await call("agent_browser_click", { selector: step.selector });
        if (step.action === "fill") response = await call("agent_browser_fill", { selector: step.selector, text: step.value });
        if (step.action === "press") response = await call("agent_browser_press", { key: step.key });
        if (response?.isError) throw new NotProvenError();
        // Preview code is untrusted and any action may navigate. Re-check the
        // exact preview origin before another browser action can run.
        await currentPreviewUrl();
      }

      const assertion = context.steps.at(-2);
      const assertionResponse = await call("agent_browser_wait_for_text", { text: assertion.text });
      const assertionPassed = assertionResponse?.isError !== true;

      const observedUrl = await currentPreviewUrl();

      const screenshotResponse = await call("agent_browser_screenshot", { format: "png" });
      if (screenshotResponse?.isError) throw new NotProvenError();
      const image = screenshotResult(screenshotResponse);
      if (!image) throw new NotProvenError();

      let receipt;
      try {
        receipt = await completeExecution({
          executionId: context.executionId,
          jobId: context.jobId,
          criterionId: context.criterionId,
          previewBootId: context.previewBootId,
          assertionPassed,
          observedUrl,
          imageBase64: image.imageBase64,
          contentType: image.contentType,
        });
      } catch {
        throw new NotProvenError();
      }
      return validAttestedReceipt(receipt, { context, assertionPassed })
        ? receipt
        : degraded("not_proven");
    } catch (error) {
      return degraded(error instanceof NotTestableError ? "not_testable" : "not_proven");
    } finally {
      if (client && typeof client.close === "function") {
        await closeBounded(client, browserSession, closeTimeoutMs);
      }
    }
  };
}
