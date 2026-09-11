// xh (星火社区) huoshan-wrapper models — Responses wire thinking passthrough.
// Regression: applyThinking flattened Responses-native `reasoning:{effort}` into
// zai/deepseek chat-wire params (thinking / reasoning_effort), which the xh
// Responses upstream rejects with 400 Unsupported parameter.
// See report: 9router-thinking-effort-20260911.md
import { describe, it, expect } from "vitest";
import { applyThinking, extractThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

// Real provider id shape for a runtime openai-compatible responses node (xh).
const XH_PROVIDER = "openai-compatible-responses-0bf9717c-2775-4a94-9202-6ed5c859d3b4";
const GLM = "openai_huoshan_glm_5_2";
const DS = "openai_huoshan_deepseek_v4_flash_ga";

const apply = (targetFormat, model, body, provider = XH_PROVIDER) => {
  const b = JSON.parse(JSON.stringify(body));
  applyThinking(targetFormat, model, b, provider);
  return b;
};

describe("xh huoshan capabilities", () => {
  it("routes both wrapper models to the Responses thinking format", () => {
    expect(getCapabilitiesForModel(XH_PROVIDER, GLM).thinkingFormat).toBe("openai-responses");
    expect(getCapabilitiesForModel(XH_PROVIDER, DS).thinkingFormat).toBe("openai-responses");
    expect(getCapabilitiesForModel(XH_PROVIDER, GLM).reasoning).toBe(true);
    expect(getCapabilitiesForModel(XH_PROVIDER, DS).reasoning).toBe(true);
  });

  it("declares per-model effort levels (Ark docs)", () => {
    expect(getThinkingLevels(XH_PROVIDER, GLM)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels(XH_PROVIDER, DS)).toEqual(["minimal", "low", "medium", "high", "max"]);
  });
});

describe("applyThinking on the Responses wire (passthrough)", () => {
  it("keeps reasoning nested and never emits flat chat-wire params (glm)", () => {
    const out = apply("openai-responses", GLM, { reasoning: { effort: "low" } });
    expect(out.reasoning).toEqual({ effort: "low" });
    expect(out.thinking).toBeUndefined();
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("passes glm levels through unchanged", () => {
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      const out = apply("openai-responses", GLM, { reasoning: { effort: level } });
      expect(out.reasoning, `glm ${level}`).toEqual({ effort: level });
      expect(out.reasoning_effort, `glm ${level}`).toBeUndefined();
      expect(out.thinking, `glm ${level}`).toBeUndefined();
    }
  });

  it("clamps deepseek xhigh→max and none→minimal (Ark docs)", () => {
    expect(apply("openai-responses", DS, { reasoning: { effort: "xhigh" } }).reasoning).toEqual({ effort: "max" });
    expect(apply("openai-responses", DS, { reasoning: { effort: "none" } }).reasoning).toEqual({ effort: "minimal" });
    for (const level of ["minimal", "low", "medium", "high", "max"]) {
      expect(apply("openai-responses", DS, { reasoning: { effort: level } }).reasoning, `ds ${level}`).toEqual({ effort: level });
    }
  });

  it("strips flat chat-wire thinking intent carried by non-Responses clients", () => {
    const out = apply("openai-responses", GLM, { reasoning_effort: "high" });
    expect(out.reasoning).toEqual({ effort: "high" });
    expect(out.reasoning_effort).toBeUndefined();
  });
});

describe("zero-change guards for other providers", () => {
  it("glm-5.2 on a chat wire keeps the zai native format", () => {
    const out = apply("openai", "glm-5.2", { reasoning: { effort: "high" } }, "zai");
    expect(out.thinking).toEqual({ type: "enabled" });
  });

  it("muse-spark (Responses wire, generic openai caps) keeps its flat behavior", () => {
    const out = apply("openai-responses", "muse-spark-1.2-contributor-free", { reasoning: { effort: "high" } }, "opencode");
    expect(out.reasoning).toBeUndefined();
    expect(out.reasoning_effort).toBe("high");
  });

  it("deepseek-v4 on a chat wire keeps thinking + reasoning_effort", () => {
    const out = apply("openai", "deepseek-v4-flash", { reasoning: { effort: "low" } }, "deepseek");
    expect(out.thinking).toEqual({ type: "enabled" });
    expect(out.reasoning_effort).toBe("high");
  });

  it("extractThinking still reads nested Responses effort", () => {
    expect(extractThinking({ reasoning: { effort: "high" } })).toEqual({ mode: "level", level: "high" });
  });
});
