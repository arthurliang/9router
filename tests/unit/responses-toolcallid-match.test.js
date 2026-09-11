import { describe, it, expect } from "vitest";
import { convertResponsesApiFormat } from "../../open-sse/translator/formats/responsesApi.js";

describe("tool_call_id consistency in convertResponsesApiFormat", () => {
  it("parallel function_calls and their outputs share the same call_id", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "call_a", name: "read_file", arguments: '{"path":"/a"}' },
        { type: "function_call", call_id: "call_b", name: "read_file", arguments: '{"path":"/b"}' },
        { type: "function_call_output", call_id: "call_a", output: "content A" },
        { type: "function_call_output", call_id: "call_b", output: "content B" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "done" }] },
      ],
    };

    const result = convertResponsesApiFormat(body);
    const messages = result.messages;

    // Find the assistant message with tool_calls
    const assistant = messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
    expect(assistant).toBeTruthy();
    expect(assistant.tool_calls).toHaveLength(2);

    const tcIds = assistant.tool_calls.map((tc) => tc.id);

    // Find tool messages
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);

    const toolIds = toolMsgs.map((m) => m.tool_call_id);

    // Every tool_call_id must match an assistant tool_call id
    for (const tid of toolIds) {
      expect(tcIds).toContain(tid);
    }
    // And vice versa
    for (const tcId of tcIds) {
      expect(toolIds).toContain(tcId);
    }
  });

  it("multi-turn: second assistant's tool_calls don't collide with first turn ids", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "q1" }] },
        { type: "function_call", call_id: "call_x", name: "search", arguments: '{"q":"a"}' },
        { type: "function_call_output", call_id: "call_x", output: "result A" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "q2" }] },
        { type: "function_call", call_id: "call_y", name: "search", arguments: '{"q":"b"}' },
        { type: "function_call_output", call_id: "call_y", output: "result B" },
      ],
    };

    const result = convertResponsesApiFormat(body);
    const messages = result.messages;

    const assistants = messages.filter((m) => m.role === "assistant" && m.tool_calls?.length);
    expect(assistants).toHaveLength(2);

    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);

    // First assistant's tool_call id must match first tool message
    expect(assistants[0].tool_calls[0].id).toBe("call_x");
    expect(toolMsgs[0].tool_call_id).toBe("call_x");

    // Second assistant's tool_call id must match second tool message
    expect(assistants[1].tool_calls[0].id).toBe("call_y");
    expect(toolMsgs[1].tool_call_id).toBe("call_y");
  });
});
