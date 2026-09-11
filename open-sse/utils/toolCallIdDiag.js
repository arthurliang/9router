// Tool-call id diagnostics: make a residual upstream 400 visible without leaking content.
//
// Upstream (Spark/huoshan Responses wrapper, and chat-wire strict gateways) rejects a turn with
//   "Tool message 'tool_call_id' does not match any 'tool_call.id' in the preceding assistant message"
// The payload alone rarely shows why: ids can be missing, empty, non-string, over-long (clamped)
// or simply ordered so a tool message no longer follows its own assistant group. This module dumps
// the *shape* of every pairing — type, length and an 8-char digest — never the id text itself.
//
// Switch: NINEROUTER_TOOLCALL_ID_DIAG (default ON, set to 0/false/off to silence).
// Sink: stderr (container-readable via `docker logs`), plus an optional file when
// NINEROUTER_TOOLCALL_ID_DIAG_FILE is set (e.g. /app/data/logs/toolcallid-diag.log).

const PREFIX = "[TOOLCALL-ID-DIAG]";
const MAX_GROUPS = 6;        // keep one dump short enough for a log line
const MAX_IDS_PER_SECTION = 12;
const MAX_MESSAGE_CHARS = 280;

export function diagEnabled(env = process.env) {
  const raw = env?.NINEROUTER_TOOLCALL_ID_DIAG;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return !["0", "false", "off", "no"].includes(String(raw).trim().toLowerCase());
}

// 8-char digest of the id text: lets two dumps be compared for equality without
// storing the id. FNV-1a keeps this module import-free (safe on every runtime).
function shortHash(value) {
  const text = String(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Redacted, comparable description of one call id.
export function describeCallId(id) {
  if (id === undefined) return "undefined";
  if (id === null) return "null";
  if (typeof id === "string") return id === "" ? "empty" : `str(len=${id.length},h=${shortHash(id)})`;
  if (typeof id === "number") return Number.isFinite(id) ? "number" : "number(nan)";
  if (Array.isArray(id)) return "array";
  if (typeof id === "object") return "object";
  return typeof id;
}

const isEmptyId = (id) => id === undefined || id === null || id === "";

function newGroup(callId) {
  return {
    calls: [describeCallId(callId)],
    callsRaw: [idKey(callId)],
    outputs: [],
    unmatched: [],
    missingOutputId: 0,
  };
}

const idKey = (id) => (typeof id === "string" ? id : `${typeof id}:${String(id)}`);

function pushOutput(group, toolCallId) {
  group.outputs.push(describeCallId(toolCallId));
  if (isEmptyId(toolCallId)) group.missingOutputId += 1;
  if (!group.callsRaw.includes(idKey(toolCallId))) group.unmatched.push(group.outputs.length - 1);
}

function emptyBucket() {
  return { calls: [], callsRaw: [], outputs: [], unmatched: [], missingOutputId: 0 };
}

// Chat wire: an assistant message with tool_calls opens a batch; the role:"tool"
// messages that follow belong to it. Any other role closes the batch.
export function scanChatMessages(messages) {
  const groups = [];
  const orphans = emptyBucket();
  let current = null;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      current = newGroup(msg.tool_calls[0]?.id);
      for (let i = 1; i < msg.tool_calls.length; i += 1) {
        current.calls.push(describeCallId(msg.tool_calls[i]?.id));
        current.callsRaw.push(idKey(msg.tool_calls[i]?.id));
      }
      groups.push(current);
      continue;
    }
    if (msg.role === "tool") {
      pushOutput(current ?? orphans, msg.tool_call_id);
      continue;
    }
    current = null;
  }
  return { groups, orphans };
}

// Responses wire: function_call items open a batch; function_call_output items
// attach to the batch that declares their call id (else to the newest open batch,
// which is exactly the mis-pairing this dump exists to expose).
export function scanResponsesItems(input) {
  const groups = [];
  const orphans = emptyBucket();
  let window = [];   // batches opened since the last message/reasoning-free boundary
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = item.type || (item.role ? "message" : null);
    if (type === "function_call") {
      const group = newGroup(item.call_id);
      groups.push(group);
      window.push(group);
      continue;
    }
    if (type === "function_call_output") {
      const owner = window.find((g) => g.callsRaw.includes(idKey(item.call_id)));
      pushOutput(owner ?? window[window.length - 1] ?? orphans, item.call_id);
      continue;
    }
    if (type === "reasoning") continue;   // reasoning between call and output must not close a batch
    window = [];
  }
  return { groups, orphans };
}

// Shape-level pairing report for a client or upstream body. Returns null when the
// body carries neither chat messages nor Responses input items.
export function buildToolCallIdDiagnostics(body) {
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body.input)) {
    const { groups, orphans } = scanResponsesItems(body.input);
    return { shape: "responses", items: body.input.length, groups, orphans };
  }
  if (Array.isArray(body.messages)) {
    const { groups, orphans } = scanChatMessages(body.messages);
    return { shape: "chat", items: body.messages.length, groups, orphans };
  }
  return null;
}

export function summarizeToolCallIdDiagnostics(diag) {
  if (!diag) return "none";
  return {
    responses: "responses",
    chat: "chat",
  }[diag.shape] + ` batches=${diag.groups.length}`;
}

function renderBucket(label, bucket, { calls = true } = {}) {
  const parts = [];
  if (calls) parts.push(`calls=[${bucket.calls.slice(0, MAX_IDS_PER_SECTION).join(",")}]`);
  parts.push(`outputs=[${bucket.outputs.slice(0, MAX_IDS_PER_SECTION).join(",")}]`);
  if (bucket.unmatched.length > 0) parts.push(`UNMATCHED=${bucket.unmatched.join(",")}`);
  if (bucket.missingOutputId > 0) parts.push(`missing_id=${bucket.missingOutputId}`);
  return `${label}{${parts.join(" ")}}`;
}

export function formatToolCallIdDiagnostics(diag) {
  if (!diag) return `${PREFIX} no chat-messages/responses-input body to inspect`;
  const parts = [`shape=${diag.shape}`, `items=${diag.items}`, `batches=${diag.groups.length}`];
  diag.groups.slice(0, MAX_GROUPS).forEach((group, i) => {
    parts.push(renderBucket(`g${i + 1}`, group));
  });
  if (diag.orphans.outputs.length > 0) {
    parts.push(renderBucket("orphan", diag.orphans, { calls: false }));
  }
  return `${PREFIX} ${parts.join(" ")}`;
}

// Verdict line: which batch (if any) breaks the chat-wire pairing contract.
export function pairingVerdict(diag) {
  if (!diag) return "unknown";
  const broken = diag.groups
    .map((group, i) => ({ i: i + 1, group }))
    .filter(({ group }) => group.unmatched.length > 0);
  if (diag.orphans.outputs.length > 0) return `orphan tool messages (${diag.orphans.outputs.length})`;
  if (broken.length === 0) return "paired";
  return `unmatched in batch ${broken.map((b) => b.i).join(",")}`;
}

function truncate(text, max = MAX_MESSAGE_CHARS) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// Dump the client body and (when different) the body actually sent upstream.
// Never throws — diagnostics must not break a request.
export async function dumpToolCallIdDiagnostics({
  clientBody = null,
  upstreamBody = null,
  statusCode = null,
  upstreamMessage = "",
  provider = "",
  model = "",
  env = process.env,
} = {}) {
  try {
    if (!diagEnabled(env)) return null;
    const lines = [`${PREFIX} ${statusCode ?? "-"} ${provider}/${model}`.trim()];
    const sections = [
      ["client", clientBody],
      ["upstream", upstreamBody && upstreamBody !== clientBody ? upstreamBody : null],
    ];
    for (const [label, body] of sections) {
      if (!body) continue;
      const diag = buildToolCallIdDiagnostics(body);
      if (!diag) continue;
      lines.push(`${label}: ${formatToolCallIdDiagnostics(diag)}`);
      lines.push(`${label}: verdict=${pairingVerdict(diag)}`);
    }
    if (upstreamMessage) lines.push(`upstream_error=${truncate(upstreamMessage)}`);
    if (lines.length === 1) return null;   // nothing id-related to report
    const text = lines.join("\n");
    console.error(text);
    await appendDiagFile(text, env);
    return text;
  } catch {
    return null;
  }
}

async function appendDiagFile(text, env) {
  const file = env?.NINEROUTER_TOOLCALL_ID_DIAG_FILE;
  if (!file) return;
  try {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, `${new Date().toISOString()} ${text}\n`);
  } catch {
    // fail open: stderr already carried the dump
  }
}
