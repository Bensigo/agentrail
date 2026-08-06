// Deterministic, plan-bound UI execution. This deliberately speaks only the
// small agent-browser MCP surface needed to exercise an already-approved
// criterion; it is not an LLM QA loop and it never discovers or follows page
// instructions.

export const REQUIRED_BROWSER_TOOLS = [
  "agent_browser_open",
  "agent_browser_click",
  "agent_browser_fill",
  "agent_browser_press",
  "agent_browser_wait_for_text",
  "agent_browser_get_url",
  "agent_browser_screenshot",
];

class NotTestableError extends Error {}
class NotProvenError extends Error {}

function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const texts = content.filter((item) => item && item.type === "text" && typeof item.text === "string").map((item) => item.text.trim()).filter(Boolean);
  return texts.length === 1 ? texts[0] : null;
}

function screenshotImage(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const image = content.find((item) => item && item.type === "image" && typeof item.data === "string" && item.data.trim() && (item.mimeType === "image/png" || item.mimeType === "image/jpeg"));
  return image ? { imageBase64: image.data.trim(), contentType: image.mimeType } : null;
}

function exactPreviewOrigin(previewUrl) {
  let preview;
  try { preview = new URL(String(previewUrl)); } catch { throw new NotTestableError("No safe exact PR-head preview URL is available"); }
  if ((preview.protocol !== "https:" && preview.protocol !== "http:") || preview.username || preview.password) throw new NotTestableError("Exact PR-head preview URL is unsafe");
  return preview.origin;
}

function openedUrl(path, origin) {
  const value = String(path ?? "").trim();
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) throw new NotProvenError("Persisted UI open step is not a safe relative path");
  const url = new URL(value, origin);
  if (url.origin !== origin) throw new NotProvenError("Persisted UI open step leaves the exact PR-head preview origin");
  return url.toString();
}

function planFor(item) {
  const plan = item?.plan ?? item;
  if (plan?.modality !== "ui") throw new NotTestableError("Direct browser executor accepts planned UI criteria only");
  if (!Array.isArray(plan.uiSteps) || plan.uiSteps.length === 0) throw new NotTestableError("Planned UI criterion has no persisted safe uiSteps action list");
  const executionId = String(item?.execution?.id ?? item?.executionId ?? "").trim();
  if (!executionId) throw new NotTestableError("Claimed verification execution has no identifier");
  const workspaceId = String(item?.workspaceId ?? "").trim();
  if (!workspaceId) throw new NotTestableError("Claimed UI execution has no workspaceId");
  const recordId = String(plan.recordId ?? "").trim();
  const prRevisionId = String(plan.prRevisionId ?? "").trim();
  if (!recordId || !prRevisionId) throw new NotTestableError("Claimed UI execution has incomplete plan identity");
  for (const [key, expected] of [["recordId", recordId], ["prRevisionId", prRevisionId]]) {
    const supplied = String(item?.[key] ?? "").trim();
    if (supplied && supplied !== expected) throw new NotTestableError(`Claimed UI execution has conflicting ${key}`);
  }
  const verificationPlanId = String(item?.execution?.verificationPlanId ?? item?.verificationPlanId ?? "").trim();
  if (!verificationPlanId) throw new NotTestableError("Claimed UI execution has no verification plan identifier");
  const suppliedPlanId = String(item?.verificationPlanId ?? "").trim();
  if (suppliedPlanId && suppliedPlanId !== verificationPlanId) throw new NotTestableError("Claimed UI execution has conflicting verification plan identifier");
  if (!String(plan.expectedBehavior ?? "").trim()) throw new NotTestableError("Planned UI criterion has no expected behavior");
  return { plan, executionId, verificationPlanId, workspaceId, recordId, prRevisionId };
}

function validStep(step, assertionSeen) {
  if (!step || typeof step !== "object" || Array.isArray(step)) throw new NotTestableError("Persisted UI step is malformed");
  const action = step.action;
  const allowed = {
    open: ["action", "path"], click: ["action", "selector"], fill: ["action", "selector", "value"],
    press: ["action", "key"], expect_text: ["action", "text"], screenshot: ["action", "label"],
  }[action];
  if (!allowed || Object.keys(step).some((key) => !allowed.includes(key)) || allowed.some((key) => typeof step[key] !== "string" || !step[key].trim())) throw new NotTestableError("Persisted UI step is malformed or carries unapproved data");
  if (action === "screenshot" && !assertionSeen) throw new NotTestableError("UI proof requires an explicit persisted assertion before screenshot evidence");
}

function result(status, observedBehavior = null, artifactIds = [], reason = null) {
  return { status, observedBehavior, artifactIds, reason };
}

function errorResult(error) {
  const reason = error instanceof Error ? error.message : String(error);
  return error instanceof NotTestableError ? result("not_testable", null, [], reason) : result("not_proven", null, [], reason);
}

/**
 * Execute only persisted UI actions through an injected MCP-shaped client.
 * Injection keeps all behaviour unit-testable without a browser or network.
 */
export function createVerificationBrowserExecutor({ createClient, uploadArtifact, makeSessionId = ({ executionId }) => `jace-verification-${executionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 96)}` }) {
  if (typeof createClient !== "function") throw new TypeError("createClient is required");
  if (typeof uploadArtifact !== "function") throw new TypeError("uploadArtifact is required");

  return async function execute(item) {
    let client;
    try {
      const { plan, executionId, verificationPlanId, workspaceId, recordId, prRevisionId } = planFor(item);
      let persistedAssertionSeen = false;
      for (const step of plan.uiSteps) {
        validStep(step, persistedAssertionSeen);
        if (step.action === "expect_text") persistedAssertionSeen = true;
      }
      const origin = exactPreviewOrigin(item.previewUrl ?? plan.previewUrl);
      const session = makeSessionId({ executionId });
      if (!session || typeof session !== "string") throw new NotTestableError("Cannot allocate an isolated verification browser session");

      try {
        client = await createClient({ url: item.agentBrowserMcpUrl, session });
        await client.connect();
      } catch {
        throw new NotTestableError("Safe browser sidecar is unavailable");
      }
      let listed;
      try { listed = await client.listTools(); } catch { throw new NotTestableError("Safe browser sidecar cannot declare its tool contract"); }
      const available = new Set((Array.isArray(listed?.tools) ? listed.tools : []).map((tool) => tool?.name).filter((name) => typeof name === "string"));
      const missing = REQUIRED_BROWSER_TOOLS.filter((name) => !available.has(name));
      if (missing.length) throw new NotTestableError(`Safe browser sidecar lacks required tools: ${missing.join(", ")}`);

      const call = async (name, args) => {
        const response = await client.callTool({ name, arguments: args });
        if (response?.isError) throw new NotProvenError(`Safe browser action ${name} failed`);
        return response;
      };

      const artifactIds = [];
      const observations = [];
      let screenshotIndex = 0;
      for (const step of plan.uiSteps) {
        const action = step?.action;
        if (action === "open") {
          await call("agent_browser_open", { url: openedUrl(step.path, origin), session });
        } else if (action === "click") {
          await call("agent_browser_click", { selector: String(step.selector ?? ""), session });
        } else if (action === "fill") {
          await call("agent_browser_fill", { selector: String(step.selector ?? ""), text: String(step.value ?? ""), session });
        } else if (action === "press") {
          await call("agent_browser_press", { key: String(step.key ?? ""), session });
        } else if (action === "expect_text") {
          await call("agent_browser_wait_for_text", { text: String(step.text ?? ""), session });
          observations.push(`observed text: ${String(step.text ?? "")}`);
        } else if (action === "screenshot") {
          const currentUrl = resultText(await call("agent_browser_get_url", { session }));
          let observed;
          try { observed = currentUrl ? new URL(currentUrl) : null; } catch { observed = null; }
          if (!observed || observed.origin !== origin) throw new NotProvenError("Browser did not report one exact-preview-origin URL before evidence capture");
          const image = screenshotImage(await call("agent_browser_screenshot", { format: "png", session }));
          if (!image) throw new NotProvenError("Browser did not return inspectable PNG/JPEG screenshot evidence");
          screenshotIndex += 1;
          const uploaded = await uploadArtifact({
            workspaceId,
            recordId,
            prRevisionId,
            verificationPlanId,
            collectedBy: `verification-executor:${executionId}`,
            index: screenshotIndex,
            imageBase64: image.imageBase64,
            contentType: image.contentType,
            observedUrl: observed.toString(),
          });
          if (!uploaded || typeof uploaded.artifactId !== "string" || !uploaded.artifactId) throw new NotProvenError("Criterion screenshot could not be stored as plan-bound evidence");
          artifactIds.push(uploaded.artifactId);
          observations.push(`captured ${String(step.label ?? "criterion screenshot")}`);
        } else {
          throw new NotProvenError("Persisted UI step is not an allowed deterministic action");
        }
      }
      if (!artifactIds.length) throw new NotProvenError("Planned UI criterion produced no decisive screenshot evidence");
      return result("proven", observations.join("; ") || "Executed persisted UI criterion actions", artifactIds, null);
    } catch (error) {
      return errorResult(error);
    } finally {
      if (client && typeof client.close === "function") {
        try { await client.close(); } catch { /* a completed claim must not hang on sidecar cleanup */ }
      }
    }
  };
}
