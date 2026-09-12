import { describe, it, expect } from "vitest";
import { interleaveResponsesToolPairs } from "../../open-sse/translator/concerns/toolCall.js";

// Upstream Responses wrappers validate every function_call_output against the
// immediately preceding assistant turn. A parallel batch that arrives grouped
// (call,call,…,out,out) therefore fails with "Tool message 'tool_call_id' does not
// match any 'tool_call.id'", emitted as a response.failed event on an HTTP 200 stream.
// The helper must interleave each call with its own outputs while leaving everything
// else (messages, reasoning, orphan outputs) exactly where it was.

const msg = (role = "user") => ({ type: "message", role, content: [{ type: "input_text", text: "x" }] });
const call = (id) => ({ type: "function_call", call_id: id, name: "exec", arguments: "{}" });
const out = (id) => ({ type: "function_call_output", call_id: id, output: "ok" });

const shape = (items) => items.map((i) => `${i.type}:${i.call_id ?? i.role ?? ""}`);

describe("interleaveResponsesToolPairs", () => {
  it("interleaves a grouped parallel batch", () => {
    const body = { input: [msg(), call("c1"), call("c2"), call("c3"), out("c1"), out("c2"), out("c3")] };
    interleaveResponsesToolPairs(body);
    expect(shape(body.input)).toEqual([
      "message:user",
      "function_call:c1", "function_call_output:c1",
      "function_call:c2", "function_call_output:c2",
      "function_call:c3", "function_call_output:c3",
    ]);
  });

  it("leaves an already interleaved batch untouched", () => {
    const items = [call("c1"), out("c1"), call("c2"), out("c2")];
    const body = { input: items };
    interleaveResponsesToolPairs(body);
    expect(body.input).toEqual(items);
  });

  it("leaves a single call/output pair untouched", () => {
    const items = [msg(), call("c1"), out("c1")];
    const body = { input: items };
    interleaveResponsesToolPairs(body);
    expect(body.input).toEqual(items);
  });

  it("keeps an orphan output in its original position", () => {
    const body = { input: [call("c1"), out("c1"), out("ghost")] };
    interleaveResponsesToolPairs(body);
    expect(shape(body.input)).toEqual(["function_call:c1", "function_call_output:c1", "function_call_output:ghost"]);
  });

  it("keeps the leading messages ahead of the tools", () => {
    const body = { input: [msg("developer"), msg("user"), msg("assistant"), call("c1"), call("c2"), out("c1"), out("c2")] };
    interleaveResponsesToolPairs(body);
    expect(shape(body.input).slice(0, 3)).toEqual(["message:developer", "message:user", "message:assistant"]);
  });

  it("does not reorder calls that carry no usable call_id", () => {
    const items = [
      { type: "function_call", call_id: "", name: "exec", arguments: "{}" },
      { type: "function_call", name: "exec", arguments: "{}" },
      { type: "function_call_output", call_id: "", output: "ok" },
    ];
    const body = { input: items };
    interleaveResponsesToolPairs(body);
    expect(body.input).toEqual(items);
  });

  it("returns bodies with no Responses input untouched", () => {
    const chat = { messages: [{ role: "user", content: "hi" }] };
    expect(interleaveResponsesToolPairs(chat)).toBe(chat);
    expect(interleaveResponsesToolPairs({ input: [] })).toEqual({ input: [] });
    expect(interleaveResponsesToolPairs(null)).toBe(null);
  });
});
