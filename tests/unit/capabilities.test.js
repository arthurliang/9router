import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("getCapabilitiesForModel", () => {
  const claudeSonnet5Expected = {
    contextWindow: 1000000,
    maxOutput: 128000,
    thinkingFormat: "claude-adaptive",
    reasoning: true,
    vision: true,
    search: true,
  };

  const kiroGpt56Expected = {
    contextWindow: 272000,
    maxOutput: 128000,
    thinkingFormat: "openai",
    reasoning: true,
    vision: true,
    search: true,
  };

  it("reports Kiro Claude Opus 5 variants as 1M adaptive-thinking models", () => {
    for (const model of [
      "claude-opus-5",
      "anthropic/claude-opus-5",
      "claude-opus-5-thinking",
      "claude-opus-5-agentic",
      "claude-opus-5-thinking-agentic",
    ]) {
      expect(getCapabilitiesForModel("kiro", model)).toMatchObject(claudeSonnet5Expected);
    }
  });

  it("reports Claude Fable 5.1 as a permanent adaptive-thinking model", () => {
    expect(getCapabilitiesForModel("claude", "claude-fable-5-1")).toMatchObject({
      ...claudeSonnet5Expected,
      thinkingCanDisable: false,
    });
  });

  it("reports Kiro Claude Opus 4.8 as a 1M context model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8-thinking").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8-thinking").contextWindow).toBe(1000000);
  });

  it("reports Kiro Claude Sonnet 5 as a 1M adaptive-thinking model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-agentic")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking-agentic")).toMatchObject(claudeSonnet5Expected);
  });

  it("reports Kiro GPT 5.6 models with the Kiro 272k context window", () => {
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-sol")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "openai/gpt-5.6-sol")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-terra-thinking")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-luna-agentic")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-sol-thinking-agentic")).toMatchObject(kiroGpt56Expected);
  });

  it("reports xh (星火) wrapper models at their real limits", () => {
    // 星火社区接口文档：huoshan_glm_5_2 与 huoshan_deepseek_v4_flash_ga 上下文窗口均为 1024k；
    // 平台固定 max_tokens 分别 128000（glm）/ 384000（ds4f）。
    // 取 1000000 与 OpenClaw 侧模型声明一致，且比 1024k 更保守（声明过高会让客户端推迟压缩、撞上游硬上限）。
    expect(getCapabilitiesForModel("xh", "openai_huoshan_deepseek_v4_flash_ga")).toMatchObject({
      reasoning: true,
      thinkingFormat: "openai-responses",
      thinkingCanDisable: true,
      contextWindow: 1000000,
      maxOutput: 384000,
    });
    expect(getCapabilitiesForModel("xh", "openai_huoshan_glm_5_2")).toMatchObject({
      reasoning: true,
      thinkingFormat: "openai-responses",
      thinkingCanDisable: true,
      contextWindow: 1000000,
      maxOutput: 128000,
    });
  });

  it("reports the local aiserver qwen3.8-27b deployment with vision and its real window", () => {
    // aiserver = club-3090 vllm/qwen38-27b-dual-ultrafast（TP=2, --max-model-len 204800）。
    // 2026-09-12 实测：vision 可用（4/4 shapes、magenta 单色图答对、无图对照答 Unknown）。
    // 窗口必须写实 204800——落 *qwen* 兜底的 262144 会让客户端推迟压缩后撞上游硬上限。
    expect(getCapabilitiesForModel("aiserver", "qwen3.8-27b")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "qwen",
      thinkingCanDisable: true,
      contextWindow: 204800,
      maxOutput: 65536,
    });
    // vendor 前缀由 baseModel 归一化后同样命中
    expect(getCapabilitiesForModel("aiserver", "aiserver/qwen3.8-27b").contextWindow).toBe(204800);
  });

  it("keeps the 200k floor for unlisted huoshan models", () => {
    // 该族其余/未来模型保持原兜底，避免未知模型被误报成大窗口
    expect(getCapabilitiesForModel("xh", "openai_huoshan_some_future_model")).toMatchObject({
      contextWindow: 200000,
      maxOutput: 128000,
      thinkingFormat: "openai-responses",
    });
  });
});
