import { describe, it, expect } from "vitest";
import { convertResponsesApiFormat } from "../../open-sse/translator/formats/responsesApi.js";
import { ensureToolCallIds, fixMissingToolResponses } from "../../open-sse/translator/concerns/toolCall.js";

// ROOT CAUSE (residual 400): Responses items arrive INTERLEAVED
// (function_call, function_call_output, function_call, function_call_output) — the
// shape a real agent turn produces for parallel tool calls. convertResponsesApiFormat
// buffered every function_call_output in pendingToolResults and only flushed them on a
// MESSAGE item, so the batch collapsed into
//   [assistant(A), assistant(B), tool(A), tool(B)]
// Two consecutive assistant messages: tool(A) no longer follows its owner, and the
// upstream rejects the turn with
//   "Tool message 'tool_call_id' does not match any 'tool_call.id' in the preceding assistant message"
//
// These tests assert the end-to-end contract on the Responses->Chat direction: every
// tool message must follow an assistant message that declares its tool_call_id.

const msg = (text, role = "user") => ({
  type: "message",
  role,
  content: [{ type: "input_text", text }],
});
const call = (callId, name = "read_file") => ({
  type: "function_call",
  call_id: callId,
  name,
  arguments: "{}",
});
const output = (callId) => ({ type: "function_call_output", call_id: callId, output: "ok" });

function convert(input) {
  return convertResponsesApiFormat({ instructions: "sys", input }).messages;
}

// The contract the upstream enforces: a tool message must be able to see its own
// tool_call id on the closest preceding assistant message.
function expectToolPairing(messages) {
  messages.forEach((m, i) => {
    if (m.role !== "tool") return;
    let j = i - 1;
    while (j >= 0 && messages[j].role === "tool") j -= 1;
    expect(j).toBeGreaterThanOrEqual(0);
    expect(messages[j].role).toBe("assistant");
    const ids = (messages[j].tool_calls || []).map((tc) => tc.id);
    expect(ids).toContain(m.tool_call_id);
  });
}

describe("Responses -> Chat: interleaved parallel calls keep their own pairing (was RED)", () => {
  it("call/output/call/output produces one assistant group per call", () => {
    const messages = convert([
      msg("go"),
      call("call_a"),
      output("call_a"),
      call("call_b"),
      output("call_b"),
      msg("done"),
    ]);
    expectToolPairing(messages);
    expect(messages.map((m) => m.role)).toEqual([
      "system", "user", "assistant", "tool", "assistant", "tool", "user",
    ]);
    expect(messages[2].tool_calls.map((tc) => tc.id)).toEqual(["call_a"]);
    expect(messages[4].tool_calls.map((tc) => tc.id)).toEqual(["call_b"]);
  });

  it("grouped parallel calls (call,call,out,out) stay one assistant group", () => {
    const messages = convert([
      msg("go"),
      call("call_a"),
      call("call_b"),
      output("call_a"),
      output("call_b"),
      msg("done"),
    ]);
    expectToolPairing(messages);
    expect(messages.map((m) => m.role)).toEqual([
      "system", "user", "assistant", "tool", "tool", "user",
    ]);
    expect(messages[2].tool_calls.map((tc) => tc.id)).toEqual(["call_a", "call_b"]);
  });

  it("multi-turn interleaved history keeps pairing on every turn", () => {
    const messages = convert([
      msg("go"),
      call("call_a"),
      output("call_a"),
      call("call_b"),
      output("call_b"),
      msg("again"),
      call("call_c"),
      call("call_d"),
      output("call_c"),
      output("call_d"),
      msg("done"),
    ]);
    expectToolPairing(messages);
  });

  it("pairing survives the tool-call repair pass (translateRequest helpers)", () => {
    const messages = convert([
      msg("go"),
      call("call_a"),
      output("call_a"),
      call("call_b"),
      output("call_b"),
      msg("done"),
    ]);
    fixMissingToolResponses(ensureToolCallIds({ messages }));
    expectToolPairing(messages);
  });
});

describe("missing call_id is repaired on both sides (was RED)", () => {
  it("assistant call and output without ids still end up paired", () => {
    const { messages } = convertResponsesApiFormat({
      instructions: "sys",
      input: [
        msg("go"),
        { type: "function_call", name: "read_file", arguments: "{}" },
        { type: "function_call_output", output: "ok" },
        msg("done"),
      ],
    });
    ensureToolCallIds({ messages });
    fixMissingToolResponses({ messages });
    expectToolPairing(messages);
    for (const m of messages) {
      if (m.role === "tool") expect(typeof m.tool_call_id === "string" && m.tool_call_id !== "").toBe(true);
    }
  });

  it("empty-string call_id is repaired on both sides", () => {
    const { messages } = convertResponsesApiFormat({
      instructions: "sys",
      input: [
        msg("go"),
        call(""),
        output(""),
        msg("done"),
      ],
    });
    ensureToolCallIds({ messages });
    fixMissingToolResponses({ messages });
    expectToolPairing(messages);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("ensureToolCallIds pairs a missing tool_call_id with its own batch position", () => {
    const body = {
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: undefined, type: "function", function: { name: "read_file", arguments: "{}" } },
            { id: undefined, type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", content: "A" },
        { role: "tool", tool_call_id: undefined, content: "B" },
      ],
    };
    ensureToolCallIds(body);
    const announced = body.messages[1].tool_calls.map((tc) => tc.id);
    expect(body.messages[2].tool_call_id).toBe(announced[0]);
    expect(body.messages[3].tool_call_id).toBe(announced[1]);
    expect(new Set(announced).size).toBe(2);
  });

  it("a valid tool_call_id is never overwritten by the batch repair", () => {
    const body = {
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_a", content: "A" },
      ],
    };
    ensureToolCallIds(body);
    expect(body.messages[2].tool_call_id).toBe("call_a");
  });
});
