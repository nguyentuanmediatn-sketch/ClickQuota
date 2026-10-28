function invalidRequest(message, param = 'input') {
  const error = new Error(message);
  error.status = 400;
  error.type = 'invalid_request_error';
  error.param = param;
  error.code = 'invalid_value';
  return error;
}

const RESPONSE_HISTORY_LIMIT = 256;
const RESPONSE_HISTORY_TTL_MS = 6 * 60 * 60 * 1000;
// 2026-10-28 (P2): cap kích thước TỪNG entry. Không cap thì 256 entry × body tới 2MiB
// giữ tới ~512MB RAM + structuredClone toàn chuỗi mỗi lần replay — memory-DoS bởi
// client hợp lệ. Entry vượt cap bị từ chối lưu (client vẫn nhận phản hồi bình thường,
// chỉ là previous_response_id kế tiếp sẽ bị "unknown/expired" như TTL hết hạn).
const RESPONSE_HISTORY_MAX_ENTRY_CHARS = 262144;
const responseHistory = new Map();

function clone(value) {
  return structuredClone(value);
}

function pruneResponseHistory(now = Date.now()) {
  for (const [responseId, entry] of responseHistory) {
    if (now - entry.createdAt > RESPONSE_HISTORY_TTL_MS) responseHistory.delete(responseId);
  }
  while (responseHistory.size > RESPONSE_HISTORY_LIMIT) {
    responseHistory.delete(responseHistory.keys().next().value);
  }
}

function getPreviousMessages(responseId) {
  pruneResponseHistory();
  const entry = responseHistory.get(responseId);
  if (!entry) return null;
  // 2026-10-28 (P2): FIFO → LRU. Refresh vị trí khi hit để hội thoại đang chạy
  // nhiều turn không bị đào thải bởi các conversation one-shot.
  responseHistory.delete(responseId);
  responseHistory.set(responseId, entry);
  return clone(entry.messages);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function valueToText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join('\n');
  if (typeof value !== 'object') return String(value);
  if (typeof value.text === 'string') return value.text;
  if (typeof value.output_text === 'string') return value.output_text;
  if (typeof value.refusal === 'string') return value.refusal;
  return safeJson(value);
}

function normalizeContentPart(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (['input_text', 'output_text', 'text', 'refusal'].includes(part.type)) {
    return { type: 'text', text: valueToText(part) };
  }
  if (['input_image', 'image_url'].includes(part.type)) {
    const image = part.image_url || part.url;
    if (image) {
      return { type: 'image_url', image_url: typeof image === 'string' ? { url: image } : image };
    }
    return { type: 'text', text: '[Attached image]' };
  }
  if (part.type === 'input_file') {
    const label = part.filename || part.file_id || part.file_url || 'file';
    return { type: 'text', text: `[Attached file: ${label}]` };
  }
  if (part.type === 'tool_use' || part.type === 'tool_result') return part;
  return { type: 'text', text: valueToText(part) };
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return valueToText(content);
  return content.map(normalizeContentPart).filter((part) => {
    if (typeof part === 'string') return part.length > 0;
    return part && (part.type !== 'text' || part.text.length > 0);
  });
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value ?? '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function appendResponsesItem(messages, item) {
  if (typeof item === 'string') {
    if (item.trim()) messages.push({ role: 'user', content: item });
    return;
  }
  if (!item || typeof item !== 'object') return;

  if (item.type === 'message' || item.role) {
    const role = item.role === 'developer' ? 'system' : (item.role || 'user');
    const content = normalizeMessageContent(item.content);
    const hasContent = typeof content === 'string' ? content.trim() : content.length > 0;
    if (hasContent) messages.push({ role, content });
    return;
  }

  if (item.type === 'function_call' || item.type === 'custom_tool_call') {
    messages.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: item.call_id || item.id || '',
        name: item.name || item.tool_name || 'tool',
        input: parseArguments(item.arguments ?? item.input),
      }],
    });
    return;
  }

  if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: item.call_id || item.id || '',
        content: valueToText(item.output),
      }],
    });
    return;
  }

  if (item.type === 'computer_call') {
    messages.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: item.call_id || item.id || '',
        name: 'computer',
        input: item.action || {},
      }],
    });
    return;
  }

  if (item.type === 'computer_call_output') {
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: item.call_id || item.id || '',
        content: valueToText(item.output || item),
      }],
    });
    return;
  }

  if (item.type === 'reasoning') {
    const summary = valueToText(item.summary);
    if (summary) messages.push({ role: 'assistant', content: summary });
    return;
  }

  const fallback = valueToText(item.content ?? item);
  if (fallback) messages.push({ role: 'user', content: fallback });
}

export function normalizeResponsesRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('Request body must be a JSON object.', null);
  }

  const messages = [];
  const instructions = valueToText(body.instructions).trim();
  if (instructions) messages.push({ role: 'system', content: instructions });

  if (body.previous_response_id) {
    const previousMessages = getPreviousMessages(body.previous_response_id);
    if (!previousMessages) {
      throw invalidRequest(
        'previous_response_id is unknown or expired; resend the prior input items.',
        'previous_response_id',
      );
    }
    messages.push(...previousMessages);
  }

  if (body.input !== undefined) {
    if (typeof body.input === 'string') {
      if (!body.input.trim()) throw invalidRequest('input must not be empty.');
      messages.push({ role: 'user', content: body.input });
    } else if (Array.isArray(body.input)) {
      if (body.input.length === 0) throw invalidRequest('input must not be empty.');
      for (const item of body.input) appendResponsesItem(messages, item);
    } else {
      throw invalidRequest('input must be a string or an array of input items.');
    }
  } else if (Array.isArray(body.messages)) {
    for (const message of body.messages) appendResponsesItem(messages, message);
  } else {
    throw invalidRequest('input is required.');
  }

  if (messages.length === 0 || !messages.some((message) => message.role !== 'system')) {
    throw invalidRequest('input must contain at least one conversation item.');
  }

  return {
    ...body,
    isResponses: true,
    messages,
    max_tokens: body.max_output_tokens ?? body.max_tokens,
  };
}

function compactId(requestId) {
  return String(requestId || 'response').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) || 'response';
}

export function createResponsesContext(requestId, createdAt = Math.floor(Date.now() / 1000)) {
  const idBase = compactId(requestId);
  return { idBase, responseId: `resp_${idBase}`, createdAt };
}

export function buildResponsesUsage(inputTokens, outputTokens) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const output = Math.max(0, Number(outputTokens) || 0);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}

export function buildResponsesOutput({ context, text = '', toolCalls = [] }) {
  const output = [];
  const responseText = String(text ?? '');

  if (responseText || toolCalls.length === 0) {
    output.push({
      id: `msg_${context.idBase}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', annotations: [], logprobs: [], text: responseText }],
    });
  }

  toolCalls.forEach((toolCall, index) => {
    const callId = toolCall.id || `call_${context.idBase}_${index}`;
    output.push({
      id: `fc_${context.idBase}_${index}`,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name: toolCall.name,
      arguments: typeof toolCall.input === 'string'
        ? toolCall.input
        : JSON.stringify(toolCall.input ?? {}),
    });
  });

  return output;
}

export function rememberResponsesConversation({ responseId, messages, output }) {
  if (!responseId || !Array.isArray(messages) || !Array.isArray(output)) return;
  const history = messages
    .filter((message) => message && message.role !== 'system')
    .map(clone);
  const assistantContent = [];

  for (const item of output) {
    if (item?.type === 'message') {
      for (const part of item.content || []) {
        if (part?.type === 'output_text' && part.text) {
          assistantContent.push({ type: 'text', text: part.text });
        }
      }
    } else if (item?.type === 'function_call') {
      assistantContent.push({
        type: 'tool_use',
        id: item.call_id || item.id || '',
        name: item.name,
        input: parseArguments(item.arguments),
      });
    }
  }

  if (assistantContent.length > 0) {
    history.push({ role: 'assistant', content: assistantContent });
  }

  // 2026-10-28 (P2): từ chối lưu entry quá lớn thay vì lưu và phình RAM.
  // Lưu ý hành vi: entry CŨ của hội thoại vẫn còn → lần replay kế tiếp phục vụ
  // context STALE (thiếu turn mới) thay vì lỗi "unknown" — graceful degradation.
  try {
    if (JSON.stringify(history).length > RESPONSE_HISTORY_MAX_ENTRY_CHARS) return;
  } catch {
    return;
  }
  responseHistory.delete(responseId);
  responseHistory.set(responseId, { createdAt: Date.now(), messages: history });
  pruneResponseHistory();
}

export function clearResponsesHistoryForTests() {
  responseHistory.clear();
}

export function buildResponsesResponse({
  context,
  rawBody,
  model,
  output = [],
  status = 'completed',
  usage = null,
  error = null,
}) {
  return {
    id: context.responseId,
    object: 'response',
    created_at: context.createdAt,
    status,
    background: false,
    error,
    incomplete_details: null,
    instructions: rawBody?.instructions ?? null,
    max_output_tokens: rawBody?.max_output_tokens ?? null,
    model,
    output,
    parallel_tool_calls: rawBody?.parallel_tool_calls !== false,
    previous_response_id: rawBody?.previous_response_id ?? null,
    reasoning: rawBody?.reasoning ?? null,
    store: false,
    temperature: rawBody?.temperature ?? null,
    text: rawBody?.text ?? { format: { type: 'text' } },
    tool_choice: rawBody?.tool_choice ?? 'auto',
    tools: Array.isArray(rawBody?.tools) ? rawBody.tools : [],
    top_p: rawBody?.top_p ?? null,
    truncation: rawBody?.truncation ?? 'disabled',
    usage,
    metadata: rawBody?.metadata ?? {},
  };
}
