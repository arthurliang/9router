import { describe, it, expect } from "vitest";
import { clampResponsesCallId, MAX_RESPONSES_CALL_ID_LEN } from "../../open-sse/translator/formats/responsesApi.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";

// ROOT CAUSE: openaiToOpenAIResponsesRequest called clampResponsesCallId once for
// assistant tool_calls[].id and once for the tool message's tool_call_id. For
// missing/empty/non-string ids each call generated a UNIQUE fallback
// (clampResponsesCallId must stay unique per call — see
// responses-parallel-tool-calls.test.js) → function_call.call_id ≠
// function_call_output.call_id → upstream 400:
//   "Tool message 'tool_call_id' does not match any 'tool_call.id' in the preceding assistant message"
//
// FIX: the translator pairs unusable ids by order — one fallback per assistant tool
// call, reused FIFO by the batch's tool messages. These tests assert the real
// end-to-end contract, not a copy of the implementation.

function build(messages) {
  return openaiToOpenAIResponsesRequest("gpt-5", { model: "gpt-5", messages }, true, null).input;
}

function callIds(input) {
  return input.filter((i) => i.type === "function_call").map((i) => i.call_id);
}

function outputIds(input) {
  return input.filter((i) => i.type === "function_call_output").map((i) => i.call_id);
}

function expectPaired(input) {
  const calls = callIds(input);
  const outputs = outputIds(input);
  expect(outputs).toHaveLength(calls.length);
  for (const id of outputs) expect(calls).toContain(id);
  // bijective: no output id may be reused for two different calls
  expect(new Set(outputs).size).toBe(outputs.length);
  expect(new Set(calls).size).toBe(calls.length);
}

function missingIdBatch(id) {
  return [
    { role: "user", content: "run both" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id, type: "function", function: { name: "read_file", arguments: '{"path":"/a"}' } },
        { id, type: "function", function: { name: "read_file", arguments: '{"path":"/b"}' } },
      ],
    },
    { role: "tool", tool_call_id: id, content: "content A" },
    { role: "tool", tool_call_id: id, content: "content B" },
    { role: "user", content: "done" },
  ];
}

describe("paired unusable call ids stay matched (was RED)", () => {
  it("undefined ids: parallel assistant calls pair with their tool results", () => {
    const input = build(missingIdBatch(undefined));
    expectPaired(input);
    expect(new Set(callIds(input)).size).toBe(2);
  });

  it("empty-string ids stay matched", () => {
    expectPaired(build(missingIdBatch("")));
  });

  it("null ids stay matched", () => {
    expectPaired(build(missingIdBatch(null)));
  });

  it("abnormal-shape (non-string) ids stay matched", () => {
    for (const id of [123, 0, {}, []]) expectPaired(build(missingIdBatch(id)));
  });

  it("missing ids still resolve to non-empty call_ ids", () => {
    for (const id of callIds(build(missingIdBatch(undefined)))) {
      expect(id.startsWith("call_")).toBe(true);
      expect(id.length).toBeLessThanOrEqual(MAX_RESPONSES_CALL_ID_LEN);
    }
  });
});

describe("usable ids stay transparent", () => {
  it("valid ids are passed through unchanged and keep their own pairing", () => {
    const input = build([
      { role: "user", content: "run both" },
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
    ]);
    expect(callIds(input)).toEqual(["call_a", "call_b"]);
    expect(outputIds(input)).toEqual(["call_a", "call_b"]);
  });

  it("a valid tool id is not stolen by a pending fallback (mixed batch)", () => {
    const input = build([
      { role: "user", content: "run both" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: undefined, type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_b", content: "B" },
      { role: "tool", tool_call_id: undefined, content: "A" },
    ]);
    const calls = callIds(input);
    expect(calls[1]).toBe("call_b");
    expect(outputIds(input)[0]).toBe("call_b");
    expect(outputIds(input)[1]).toBe(calls[0]);
    expectPaired(input);
  });

  it("overlong ids are clamped identically on both sides", () => {
    const long = "call_" + "x".repeat(80);
    const input = build([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: long, type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: long, content: "A" },
    ]);
    expect(callIds(input)[0]).toBe(outputIds(input)[0]);
    expect(callIds(input)[0].length).toBe(MAX_RESPONSES_CALL_ID_LEN);
  });
});

describe("multi-turn: fallbacks never leak across batches", () => {
  it("each turn's missing-id calls pair only with that turn's results", () => {
    const input = build([
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: undefined, type: "function", function: { name: "search", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: undefined, content: "result A" },
      { role: "user", content: "q2" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "", type: "function", function: { name: "search", arguments: "{}" } },
          { id: "", type: "function", function: { name: "search", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "", content: "result B" },
      { role: "tool", tool_call_id: "", content: "result C" },
    ]);

    const calls = callIds(input);
    const outputs = outputIds(input);
    expect(calls).toHaveLength(3);
    expect(outputs).toHaveLength(3);
    expectPaired(input);

    // turn 1 result must pair with turn 1 call (first call / first output)
    expect(outputs[0]).toBe(calls[0]);
    // turn 2 results pair with turn 2 calls, in order
    expect(outputs[1]).toBe(calls[1]);
    expect(outputs[2]).toBe(calls[2]);
    expect(new Set(calls).size).toBe(3);
  });
});

// clampResponsesCallId itself is intentionally NOT made deterministic for missing ids:
// a single shared constant would collide for parallel calls (see
// responses-parallel-tool-calls.test.js "fallback call_ids stay unique within a batch").
describe("clampResponsesCallId keeps unique fallbacks (pairing lives in the translator)", () => {
  it("generates a distinct fallback per unusable call", () => {
    const ids = new Set(Array.from({ length: 50 }, () => clampResponsesCallId(undefined)));
    expect(ids.size).toBe(50);
    expect(new Set([clampResponsesCallId(""), clampResponsesCallId(null)]).size).toBe(2);
  });

  it("passes usable ids through and truncates overlong ones", () => {
    expect(clampResponsesCallId("call_ok")).toBe("call_ok");
    expect(clampResponsesCallId("c".repeat(100)).length).toBe(MAX_RESPONSES_CALL_ID_LEN);
  });
});
