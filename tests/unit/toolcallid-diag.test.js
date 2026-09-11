import { describe, it, expect, vi, afterEach } from "vitest";
import {
  describeCallId,
  buildToolCallIdDiagnostics,
  formatToolCallIdDiagnostics,
  pairingVerdict,
  diagEnabled,
  dumpToolCallIdDiagnostics,
} from "../../open-sse/utils/toolCallIdDiag.js";

// The dump must (a) expose the pairing that an upstream rejects and (b) never leak
// id content — only type, length and an 8-char digest.

const msg = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const call = (callId) => ({ type: "function_call", call_id: callId, name: "read_file", arguments: "{}" });
const output = (callId) => ({ type: "function_call_output", call_id: callId, output: "ok" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeCallId redacts content", () => {
  it("tags missing and empty ids distinctly", () => {
    expect(describeCallId(undefined)).toBe("undefined");
    expect(describeCallId(null)).toBe("null");
    expect(describeCallId("")).toBe("empty");
  });

  it("tags non-string ids by type", () => {
    expect(describeCallId(12345)).toBe("number");
    expect(describeCallId({})).toBe("object");
    expect(describeCallId([])).toBe("array");
  });

  it("reports length and digest for strings, never the text", () => {
    const described = describeCallId("call_super_secret_123");
    expect(described).toMatch(/^str\(len=21,h=[0-9a-f]{8}\)$/);
    expect(described).not.toContain("secret");
    expect(described.slice(-8)).toBe(describeCallId("call_super_secret_123").slice(-8));
    expect(describeCallId("call_a")).toBe(describeCallId("call_a"));
    expect(describeCallId("call_a")).not.toBe(describeCallId("call_b"));
  });
});

describe("chat-shape diagnostics", () => {
  it("marks a tool message whose id no batch declares", () => {
    const diag = buildToolCallIdDiagnostics({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_zzz", content: "A" },
      ],
    });
    expect(diag.shape).toBe("chat");
    expect(diag.groups).toHaveLength(1);
    expect(diag.groups[0].unmatched).toEqual([0]);
    expect(pairingVerdict(diag)).toContain("unmatched in batch 1");
  });

  it("reports missing tool_call_id and orphan tool messages", () => {
    const diag = buildToolCallIdDiagnostics({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        { role: "tool", content: "A" },
        { role: "user", content: "next" },
        { role: "tool", tool_call_id: "call_orphan", content: "B" },
      ],
    });
    expect(diag.groups[0].missingOutputId).toBe(1);
    expect(diag.orphans.outputs).toHaveLength(1);
    expect(pairingVerdict(diag)).toContain("orphan");
  });

  it("reports a clean turn as paired", () => {
    const diag = buildToolCallIdDiagnostics({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } },
            { id: "call_b", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: "A" },
        { role: "tool", tool_call_id: "call_b", content: "B" },
      ],
    });
    expect(pairingVerdict(diag)).toBe("paired");
  });
});

describe("responses-shape diagnostics", () => {
  it("attributes interleaved outputs to the batch that declares them", () => {
    const diag = buildToolCallIdDiagnostics({
      input: [msg("go"), call("call_a"), output("call_a"), call("call_b"), output("call_b")],
    });
    expect(diag.shape).toBe("responses");
    expect(diag.groups).toHaveLength(2);
    expect(diag.groups[0].unmatched).toEqual([]);
    expect(diag.groups[1].unmatched).toEqual([]);
    expect(diag.orphans.outputs).toHaveLength(0);
  });

  it("flags an output whose call id no batch declares", () => {
    const diag = buildToolCallIdDiagnostics({
      input: [msg("go"), call("call_a"), output("call_other")],
    });
    expect(diag.groups[0].unmatched).toEqual([0]);
  });
});

describe("dump wiring", () => {
  it("is on by default and silenced by an explicit off switch", () => {
    expect(diagEnabled({})).toBe(true);
    expect(diagEnabled({ NINEROUTER_TOOLCALL_ID_DIAG: "0" })).toBe(false);
    expect(diagEnabled({ NINEROUTER_TOOLCALL_ID_DIAG: "off" })).toBe(false);
    expect(diagEnabled({ NINEROUTER_TOOLCALL_ID_DIAG: "1" })).toBe(true);
  });

  it("writes the redacted dump to stderr and never the raw id", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const text = await dumpToolCallIdDiagnostics({
      clientBody: { messages: [{ role: "tool", tool_call_id: "call_do_not_log_me" }] },
      upstreamBody: { input: [call("call_a"), output("call_b")] },
      statusCode: 400,
      upstreamMessage: "Tool message 'tool_call_id' does not match any 'tool_call.id'",
      provider: "xh",
      model: "openai_huoshan_deepseek_v4_flash_ga",
      env: {},
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(text).toContain("verdict=");
    expect(text).toContain("upstream_error=");
    expect(text).not.toContain("call_do_not_log_me");
    expect(text).not.toContain("call_b");
    expect(formatToolCallIdDiagnostics(buildToolCallIdDiagnostics({ input: [call("call_a")] }))).not.toContain("call_a");
  });

  it("stays silent when switched off", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const text = await dumpToolCallIdDiagnostics({
      clientBody: { messages: [{ role: "tool", tool_call_id: "call_a" }] },
      statusCode: 400,
      env: { NINEROUTER_TOOLCALL_ID_DIAG: "0" },
    });
    expect(text).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null for bodies with nothing id-related to report", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const text = await dumpToolCallIdDiagnostics({ clientBody: { model: "x" }, statusCode: 400, env: {} });
    expect(text).toBeNull();
  });
});
