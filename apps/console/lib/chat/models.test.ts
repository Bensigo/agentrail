import { describe, expect, it } from "vitest";
import {
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL_ID,
  chatModelOptions,
  enabledChatModelIds,
  isChatModelEnabled,
  isKnownChatModelId,
  parseModelEndpoints,
} from "./models";

describe("CHAT_MODELS", () => {
  it("lists the default model first (the one Jace actually runs today)", () => {
    expect(CHAT_MODELS[0]!.id).toBe(DEFAULT_CHAT_MODEL_ID);
    expect(DEFAULT_CHAT_MODEL_ID).toBe("anthropic/claude-sonnet-4.6");
  });

  it("has unique ids", () => {
    const ids = CHAT_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("isKnownChatModelId", () => {
  it("recognizes listed ids and rejects others", () => {
    expect(isKnownChatModelId(DEFAULT_CHAT_MODEL_ID)).toBe(true);
    expect(isKnownChatModelId("made/up-model")).toBe(false);
  });
});

describe("parseModelEndpoints", () => {
  it("returns an empty map when the env var is unset", () => {
    expect(parseModelEndpoints({}).size).toBe(0);
  });

  it("parses comma-separated id=url pairs and strips trailing slashes", () => {
    const map = parseModelEndpoints({
      CONSOLE_MODEL_ENDPOINTS:
        "anthropic/claude-opus-4.8=http://127.0.0.1:2001/,z-ai/glm-5.2=http://127.0.0.1:2002",
    });
    expect(map.get("anthropic/claude-opus-4.8")).toBe("http://127.0.0.1:2001");
    expect(map.get("z-ai/glm-5.2")).toBe("http://127.0.0.1:2002");
  });

  it("skips malformed entries without throwing", () => {
    const map = parseModelEndpoints({
      CONSOLE_MODEL_ENDPOINTS: "noequals, =http://x , modelonly= , good/id=http://ok:3000",
    });
    expect([...map.keys()]).toEqual(["good/id"]);
    expect(map.get("good/id")).toBe("http://ok:3000");
  });
});

describe("enabledChatModelIds / isChatModelEnabled", () => {
  it("always enables the default model, even with no endpoints configured", () => {
    expect(enabledChatModelIds({}).has(DEFAULT_CHAT_MODEL_ID)).toBe(true);
    expect(isChatModelEnabled(DEFAULT_CHAT_MODEL_ID, {})).toBe(true);
  });

  it("does not enable a non-default model until an endpoint is wired for it", () => {
    expect(isChatModelEnabled("z-ai/glm-5.2", {})).toBe(false);
    expect(
      isChatModelEnabled("z-ai/glm-5.2", {
        CONSOLE_MODEL_ENDPOINTS: "z-ai/glm-5.2=http://127.0.0.1:2002",
      })
    ).toBe(true);
  });
});

describe("chatModelOptions", () => {
  it("flags exactly the default as enabled out of the box", () => {
    const options = chatModelOptions({});
    const enabled = options.filter((o) => o.enabled).map((o) => o.id);
    expect(enabled).toEqual([DEFAULT_CHAT_MODEL_ID]);
  });

  it("flags a wired non-default model as enabled too", () => {
    const options = chatModelOptions({
      CONSOLE_MODEL_ENDPOINTS: "anthropic/claude-opus-4.8=http://127.0.0.1:2001",
    });
    const enabled = options.filter((o) => o.enabled).map((o) => o.id).sort();
    expect(enabled).toEqual(["anthropic/claude-opus-4.8", DEFAULT_CHAT_MODEL_ID].sort());
  });
});
