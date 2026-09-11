import { describe, it, expect } from "vitest";
import { clampResponsesCallId } from "../../open-sse/translator/formats/responsesApi.js";

// ROOT CAUSE: openaiToOpenAIResponsesRequest (request/openai-responses.js lines 406 & 417)
// calls clampResponsesCallId independently for assistant tool_calls[].id and tool messages'
// tool_call_id. When the original ID is missing/empty, each call generates a UNIQUE fallback
// → function_call.call_id ≠ function_call_output.call_id → upstream 400:
//   "Tool message 'tool_call_id' does not match any 'tool_call.id' in the preceding assistant message"
//
// This test asserts the DESIRED behavior: the same missing/empty input should produce
// the SAME fallback when called in the same turn for the same logical tool call pair.
// Currently RED — clampResponsesCallId has no pairing mechanism.

describe("clampResponsesCallId pairing consistency (RED: currently fails)", () => {
  it("paired undefined IDs should produce matching call_ids", () => {
    // Simulates lines 406 & 417 for a tool call where both tc.id and tool_call_id are undefined
    const fromAssistant = clampResponsesCallId(undefined);
    const fromToolMessage = clampResponsesCallId(undefined);
    expect(fromAssistant).toBe(fromToolMessage); // EXPECT GREEN after fix
  });

  it("paired empty-string IDs should produce matching call_ids", () => {
    const fromAssistant = clampResponsesCallId("");
    const fromToolMessage = clampResponsesCallId("");
    expect(fromAssistant).toBe(fromToolMessage); // EXPECT GREEN after fix
  });

  it("paired null IDs should produce matching call_ids", () => {
    const fromAssistant = clampResponsesCallId(null);
    const fromToolMessage = clampResponsesCallId(null);
    expect(fromAssistant).toBe(fromToolMessage); // EXPECT GREEN after fix
  });
});
