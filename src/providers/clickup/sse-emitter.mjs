/**
 * SSE Emitter helpers — Protocol-exact streaming cho ClickUp upstream models.
 * 2026-10-29: Real-time Streaming Engine (Master Directive).
 *
 * - sliceSafeUtf8: không bao giờ cắt đôi surrogate pair tiếng Việt/emoji trong delta.
 * - ensureValidArgsJson: Stream Finalizer — JSON hỏng (thiếu ngoặc, bọc fence) được
 *   vá bằng repairJsonBuffer trước khi đóng block tool_use / tool_calls; nếu không
 *   vá được thì bọc {raw} — client không bao giờ nhận partial_json lỗi cú pháp.
 * - emitOpenAiToolCallDeltas: chunk mở đầu {index, id, type:"function", function:{name, arguments:""}},
 *   sau đó stream từng phần function.arguments (parallel calls = index tăng dần),
 *   chunk cuối riêng chứa finish_reason: "tool_calls".
 */
import { repairJsonBuffer } from '../../tools/json-repair.mjs';

export function sliceSafeUtf8(text, start, size) {
  const end0 = Math.min(start + size, text.length);
  let end = end0;
  if (end > start && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  }
  return { chunk: text.slice(start, end), next: end };
}

export function ensureValidArgsJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '{}';
  try {
    JSON.parse(raw);
    return raw;
  } catch { /* fall through to repair */ }
  try {
    const repaired = repairJsonBuffer(raw);
    if (repaired && typeof repaired === 'object' && !repaired.raw_arguments) {
      return JSON.stringify(repaired);
    }
  } catch { /* fall through */ }
  return JSON.stringify({ raw });
}

/**
 * Stream tool calls theo chuẩn OpenAI delta protocol.
 * @param {Function} write  (obj) => void  — phát 1 SSE data chunk
 * @param {object} opts { requestId, model, toolCalls, argumentChunkSize, abortCheck, sleep, delayMs }
 */
export function emitOpenAiToolCallDeltas(write, opts = {}) {
  const {
    requestId,
    model,
    toolCalls,
    argumentChunkSize = 96,
    abortCheck = () => false,
    sleep = () => Promise.resolve(),
    delayMs = 2,
  } = opts;
  const chunkHeader = (delta, finish = null) => ({
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  for (let idx = 0; idx < toolCalls.length; idx++) {
    if (abortCheck()) return;
    const tc = toolCalls[idx];
    // 1. Chunk mở đầu: name + arguments rỗng
    write(chunkHeader({
      tool_calls: [{
        index: idx,
        id: tc.id || `call_${Date.now().toString(36)}_${idx}`,
        type: 'function',
        function: { name: tc.name, arguments: '' },
      }],
    }));
    // 2. Argument deltas (JSON đã hợp lệ hóa)
    const argsJson = ensureValidArgsJson(typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}));
    for (let i = 0; i < argsJson.length; i += argumentChunkSize) {
      if (abortCheck()) return;
      const { chunk, next } = sliceSafeUtf8(argsJson, i, argumentChunkSize);
      write(chunkHeader({
        tool_calls: [{ index: idx, function: { arguments: chunk } }],
      }));
      i = next - 1; // vòng for tự += chunkSize
      if (delayMs) void sleep(delayMs);
    }
  }
  // 3. Chunk kết thúc riêng với finish_reason: "tool_calls"
  write(chunkHeader({}, 'tool_calls'));
}

/**
 * Chuẩn hóa tool_choice từ cả 2 giao thức (OpenAI + Anthropic + Responses).
 * @returns {{ mode: 'auto'|'none'|'required'|'named', name: string|null }}
 */
export function normalizeToolChoice(rawToolChoice) {
  if (!rawToolChoice) return { mode: 'auto', name: null };
  if (rawToolChoice === 'none') return { mode: 'none', name: null };
  if (rawToolChoice === 'required' || rawToolChoice === 'any') return { mode: 'required', name: null };
  if (typeof rawToolChoice === 'object') {
    const fnName = rawToolChoice.function?.name || rawToolChoice.name;
    if (rawToolChoice.type === 'function' && fnName) return { mode: 'named', name: fnName };
    if (rawToolChoice.type === 'tool' && rawToolChoice.name) return { mode: 'named', name: rawToolChoice.name };
    if (rawToolChoice.type === 'any') return { mode: 'required', name: null };
    if (rawToolChoice.type === 'auto') return { mode: 'auto', name: null };
  }
  return { mode: 'auto', name: null };
}

/**
 * Client directive thêm vào prompt card theo tool_choice (ngoài EXECUTION MODEL mặc định).
 */
export function toolChoiceDirective(toolChoice) {
  if (!toolChoice || toolChoice.mode === 'auto') return '';
  if (toolChoice.mode === 'required') {
    return '\nCLIENT DIRECTIVE: the client requires at least one tool call in this response. Emit exactly one supported tool-call format now with complete arguments.\n';
  }
  if (toolChoice.mode === 'named') {
    return `\nCLIENT DIRECTIVE: the client requires you to call the tool "${toolChoice.name}" in this response, with complete arguments, using one of the supported formats below.\n`;
  }
  return '';
}
