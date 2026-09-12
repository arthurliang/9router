import { describe, it, expect } from "vitest";
import { describeResponsesItemForProbe } from "../../open-sse/utils/stream.js";

// REBUILD-PROBE 的格式化器：把每个 output item 缩减为 type:id:内容指标，
// 让「上游快照把 message 项丢了/掏空」在生产日志里一眼可见
// （spark-hub responses 包装观察到的模式：快照只剩 function_call）。
// 指标口径：message/reasoning → content 各段 text 字符数合计；
// function_call → arguments 字符串长度；function_call_output → output 长度。

describe("describeResponsesItemForProbe", () => {
  it("message 带正文 → 打出 content 字符数", () => {
    const out = describeResponsesItemForProbe({
      type: "message",
      id: "msg_abcdef123456",
      content: [{ type: "output_text", text: "你好世界" }],
    });
    expect(out).toBe("message:msg_abcdef:content=4");
  });

  it("message 空正文 → content=0（空正文即此可见）", () => {
    const out = describeResponsesItemForProbe({ type: "message", id: "msg_empty", content: [] });
    expect(out).toBe("message:msg_empty:content=0");
  });

  it("多段 content 合计字符数", () => {
    const out = describeResponsesItemForProbe({
      type: "message",
      id: "msg_multi",
      content: [{ type: "output_text", text: "ab" }, { type: "output_text", text: "cd" }],
    });
    expect(out).toBe("message:msg_multi:content=4");
  });

  it("function_call → args 长度", () => {
    const out = describeResponsesItemForProbe({
      type: "function_call",
      call_id: "fc_1234567890",
      arguments: '{"x":1}',
    });
    expect(out).toBe("function_call:fc_1234567:args=7");
  });

  it("function_call_output → output 长度", () => {
    const out = describeResponsesItemForProbe({ type: "function_call_output", call_id: "fc_x", output: "ok" });
    expect(out).toBe("function_call_output:fc_x:out=2");
  });

  it("reasoning → content 字符数", () => {
    const out = describeResponsesItemForProbe({
      type: "reasoning",
      id: "rs_1",
      content: [{ type: "output_text", text: "think" }],
    });
    expect(out).toBe("reasoning:rs_1:content=5");
  });

  it("非对象 → null", () => {
    expect(describeResponsesItemForProbe(null)).toBe("null");
    expect(describeResponsesItemForProbe(undefined)).toBe("null");
  });
});
