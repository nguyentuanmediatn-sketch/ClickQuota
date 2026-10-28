import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { clickupPool } from './pool.mjs';
import { alertEvents, ALERT_EVENTS } from '../../alert/events.mjs';
import { detectIDE } from '../../ide-detect.mjs';
import { extractTextToolCalls } from '../../tools/text-fallback.mjs';
import { estimateTokens } from '../../tokens.mjs';
import {
  buildResponsesOutput,
  buildResponsesResponse,
  buildResponsesUsage,
  createResponsesContext,
  rememberResponsesConversation,
} from '../../protocols/openai-responses.mjs';
import {
  buildClickUpToolPromptCard,
  createClickUpToolMapper,
  extractPreToolText,
} from './tools.mjs';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

export const CLICKUP_MODELS = [
  'super-agent-CL',
  'super-agent-builder-CL',
  'gpt-6-astra-CL',
  'gpt-6-luna-CL',
  'gpt-6.1-sol-CL',
  'gpt-5.6-terra-CL',
  'gpt-5.6-luna-CL',
  'claude-opus-5-5-CL',
  'claude-opus-5-CL',
  'claude-opus-4-6-CL',
  'claude-sonnet-5-5-CL',
  'claude-3-7-sonnet-CL',
  'claude-haiku-5-5-CL',
  'claude-haiku-4-5-CL',
  'google/gemini-4-argon-CL',
  'google/gemini-3.8-flash-CL',
  'google/gemini-3.5-flash-lite-CL',
  'global.anthropic.claude-opus-5-5-CL',
  'global.anthropic.claude-opus-5-CL',
  'gpt-4o-CL',
  'brain-CL',
];

// Note: Server routes using isClickUpModel(model, config) from ./config.mjs

/**
 * Session affinity key: hash ổn định của hội thoại (salt theo client + tin nhắn user đầu tiên).
 * Bối cảnh hội thoại đi theo payload (client gửi đủ lịch sử mỗi lượt) nên affinity chỉ là
 * tối ưu hiệu năng trên cùng workspace — không phải điều kiện đúng/sai của request.
 */
function computeSessionKey(req, rawBody) {
  try {
    const msgs = Array.isArray(rawBody?.messages) ? rawBody.messages : [];
    const firstUser = msgs.find((m) => m && m.role === 'user');
    if (!firstUser) return null;
    const content = typeof firstUser.content === 'string'
      ? firstUser.content
      : JSON.stringify(firstUser.content || '');
    if (!content) return null;
    const clientSalt = String(req?.headers?.authorization || req?.headers?.['x-api-key'] || '').slice(0, 72);
    return createHash('sha256').update(clientSalt + '\u0000' + content.slice(0, 512)).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

export function resolveClickUpModel(reqModel) {
  let model = reqModel || 'gpt-6-luna';
  model = String(model).trim();

  // Bóc tách provider/namespace tiền tố (ví dụ: 'ho/gpt-6-luna-CL', 'provider=new-provider/gpt-6-luna-CL')
  if (model.includes('/')) {
    const parts = model.split('/');
    if (parts.length > 2 && parts[1].toLowerCase() === 'google') {
      model = parts.slice(1).join('/');
    } else if (parts.length === 2 && parts[0].toLowerCase() === 'google') {
      // Giữ nguyên google/...
    } else {
      model = parts.pop();
    }
  }

  model = model.replace(/[\s_]+/g, '-');
  model = model.replace(/[-_]cl$/i, '');
  model = model.replace(/[-_]thinking$/i, '');

  const aliases = {
    // ── Universal Tier 1 Tool-Calling Engine (All models use claude-opus-5-5 for 200k context & reliable tools) ──
    brain: 'claude-opus-5-5',
    'claude-opus-5-5': 'claude-opus-5-5',
    'claude-opus-5': 'claude-opus-5-5',
    'claude-opus-4-6': 'claude-opus-5-5',
    'claude-opus-5.5': 'claude-opus-5-5',
    'claude-3-5-opus': 'claude-opus-5-5',
    'claude-3-opus': 'claude-opus-5-5',
    'claude-sonnet-5-5': 'claude-opus-5-5',
    'claude-3-7-sonnet': 'claude-opus-5-5',
    'claude-3-7-sonnet-CL': 'claude-opus-5-5',
    'claude-3-5-sonnet': 'claude-opus-5-5',
    'claude-3-5-sonnet-20241022': 'claude-opus-5-5',
    'claude-3-haiku': 'claude-opus-5-5',
    'claude-haiku-4-5': 'claude-opus-5-5',
    'claude-haiku-5-5': 'claude-opus-5-5',
    'claude-haiku': 'claude-opus-5-5',
    'haiku-5': 'claude-opus-5-5',
    'global.anthropic.claude-opus-5-5': 'claude-opus-5-5',
    'global.anthropic.claude-opus-5': 'claude-opus-5-5',
    'super-agent': 'claude-opus-5-5',
    'super-agent-builder': 'claude-opus-5-5',
    piebald: 'claude-opus-5-5',
    'piebald-expert': 'claude-opus-5-5',
    'piebald-coder': 'claude-opus-5-5',

    // ── GPT / OpenAI Family (Routed to claude-opus-5-5 for full tool-calling execution) ──
    premium: 'claude-opus-5-5',
    standard: 'claude-opus-5-5',
    codex: 'claude-opus-5-5',
    zcode: 'claude-opus-5-5',
    'openai/codex': 'claude-opus-5-5',
    'code-davinci-002': 'claude-opus-5-5',
    'gpt-6.1-sol': 'claude-opus-5-5',
    'gpt-6-luna': 'claude-opus-5-5',
    'gpt-6-astra': 'claude-opus-5-5',
    'gpt-5.6-luna': 'claude-opus-5-5',
    'gpt-5.6-terra': 'claude-opus-5-5',
    'gpt-5.4': 'claude-opus-5-5',
    'agent-v1-unified-5-4': 'claude-opus-5-5',
    'gpt-4o': 'claude-opus-5-5',
    'gpt-4o-mini': 'claude-opus-5-5',
    'gpt-4': 'claude-opus-5-5',
    'gpt-3.5-turbo': 'claude-opus-5-5',
    astra: 'claude-opus-5-5',
    'gpt-astra': 'claude-opus-5-5',

    // ── Google Gemini Family (Routed to gemini-4-argon or claude-opus-5-5) ──
    'google/gemini-4-argon': 'google/gemini-4-argon',
    'gemini-4-argon': 'google/gemini-4-argon',
    'gemini-4': 'google/gemini-4-argon',
    argon: 'google/gemini-4-argon',
    'google/gemini-3.8-flash': 'google/gemini-4-argon',
    'gemini-3.8-flash': 'google/gemini-4-argon',
    'google/gemini-3.5-flash-lite': 'google/gemini-4-argon',
    'gemini-3.5-flash-lite': 'google/gemini-4-argon',
    'gemini-flash': 'google/gemini-4-argon',
    'gemini-1.5-flash': 'google/gemini-4-argon',
    'gemini-2.0-flash': 'google/gemini-4-argon',
    'gemini-1.5-pro': 'google/gemini-4-argon',
    'gemini-2.0-pro': 'google/gemini-4-argon'
  };

  return aliases[model] || model;
}

function serializeMessageContent(msg) {
  if (!msg) return '';
  const content = msg.content;
  let serialized = '';
  if (typeof content === 'string') {
    serialized = content;
  } else if (Array.isArray(content)) {
    serialized = content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (['text', 'input_text', 'output_text', 'refusal'].includes(part.type)) return part.text || part.refusal || '';
        if (part.type === 'tool_use') {
          return `\n<tool_call id="${part.id || ''}">{"name": "${part.name}", "arguments": ${JSON.stringify(part.input || {})}}</tool_call>\n`;
        }
        if (part.type === 'tool_result') {
          const resText = typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '');
          return `\n<tool_result id="${part.tool_use_id || ''}">${resText}</tool_result>\n`;
        }
        if (part.type === 'image_url' && part.image_url) {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
          if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
            return `\n![image](${url})\n`;
          }
          return '\n[Attached Image]\n';
        }
        if (part.type === 'image' && part.source) {
          const mediaType = part.source.media_type || 'image/png';
          if (part.source.url && (part.source.url.startsWith('http://') || part.source.url.startsWith('https://'))) {
            return `\n![image](${part.source.url})\n`;
          }
          return `\n[Attached Image (${mediaType})]\n`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  } else {
    // 2026-10-28 (P2): content dạng object (vd rawBody.system object của Anthropic)
    // phải được serialize thành JSON, không phải '[object Object]'.
    serialized = typeof content === 'object' && content !== null ? JSON.stringify(content) : String(content || '');
  }

  if ((msg.role === 'tool' || msg.role === 'function') && serialized) {
    return `\n<tool_result id="${msg.tool_call_id || msg.name || ''}">${serialized}</tool_result>\n`;
  }

  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const functionCall = msg.function_call ? [msg.function_call] : [];
  const serializedCalls = [...toolCalls, ...functionCall]
    .map((call) => {
      const fn = call?.function || call;
      if (!fn?.name) return '';
      const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
      return `\n<tool_call id="${call?.id || ''}">{"name": "${fn.name}", "arguments": ${args}}</tool_call>\n`;
    })
    .filter(Boolean)
    .join('\n');

  return [serialized, serializedCalls].filter(Boolean).join('\n');
}

export function messagesToPrompt(messages, maxChars = 200000) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  const items = messages
    .map((m) => {
      const role = m?.role ?? 'user';
      const content = serializeMessageContent(m);
      return { role, text: content ? `${role}: ${content}` : '' };
    })
    .filter((m) => m.text.length > 0);

  if (items.length === 0) return '';

  let systemText = '';
  let rest = items;
  if (items[0].role === 'system') {
    systemText = items[0].text;
    rest = items.slice(1);
  }

  let remaining = maxChars - (systemText ? systemText.length + 4 : 0);
  const selected = [];

  for (let i = rest.length - 1; i >= 0; i--) {
    const t = rest[i].text;
    if (t.length <= remaining) {
      selected.unshift(t);
      remaining -= t.length + 2;
    } else {
      if (selected.length === 0) {
        selected.push(t.slice(0, remaining));
      }
      break;
    }
  }

  return (systemText ? [systemText, ...selected] : selected).join('\n\n');
}

export function pruneToolsForContext(tools) {
  if (!Array.isArray(tools) || tools.length <= 15) return tools;
  // Lọc bớt các tool MCP document/pdf/presentation/spreadsheets viewer và cron/workflow rác làm phình context
  return tools.filter((t) => {
    const name = t.name || t.function?.name || '';
    if (/^mcp__plugin_(?:documents|pdf|presentations|spreadsheets)/i.test(name)) return false;
    if (/^(?:Cron|OffPeak|CreateWorkflow|AmendWorkflow|SaveWorkflow|EvalWorkflow|ListWorkflow|GetWorkflow|ResumeWorkflow|ResolveWorkflow|FillWorkflow|ListSavedWorkflows)/i.test(name)) return false;
    return true;
  });
}

export function formatToolsPrompt(tools, ideType = 'unknown') {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const pruned = pruneToolsForContext(tools);
  return buildClickUpToolPromptCard(pruned, ideType);
}


export function cleanTruncateMessage(content, maxLen = 45000) {
  if (!content || content.length <= maxLen) return content;
  // If inside <system-reminder>, cut cleanly at newline before maxLen and close tag
  if (content.includes('<system-reminder>')) {
    const lastNewline = content.lastIndexOf('\n', maxLen - 120);
    const cutPos = lastNewline > 1000 ? lastNewline : maxLen - 120;
    // 2026-10-28 (P3): chỉ đóng tag khi opener nằm TRƯỚC điểm cắt — nếu
    // <system-reminder> xuất hiện sau cutPos thì thêm </system-reminder>
    // tạo tag đóng mồ côi (và slice có thể cắt đôi surrogate pair).
    const openerPos = content.indexOf('<system-reminder>');
    const suffix = openerPos >= 0 && openerPos < cutPos ? '\n\n...[skills catalog truncated for context efficiency]\n</system-reminder>' : '\n\n...[content truncated for brevity]';
    return content.slice(0, cutPos) + suffix;
  }
  const lastNewline = content.lastIndexOf('\n', maxLen - 80);
  const cutPos = lastNewline > 1000 ? lastNewline : maxLen - 80;
  return content.slice(0, cutPos) + '\n\n...[content truncated for brevity]';
}

/**
 * Phân tích ý định người dùng từ lịch sử hội thoại:
 * - Nếu là xác nhận ngắn ("đúng rồi", "ok", "tiếp tục"): tự động móc nối với yêu cầu trước đó để tránh mất ngữ cảnh.
 * - Nếu là câu hỏi tư vấn/chiến lược ("e có gợi ý gì k"): chuyển sang chế độ tư vấn kiến trúc thay vì ép chạy tool mù quáng.
 */
export function resolveActiveUserIntent(rawMessages, fallbackContent = 'Hello') {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return {
      content: fallbackContent,
      isConsultation: false,
      isConfirmation: false,
    };
  }

  const userMsgs = rawMessages.filter((m) => m && m.role === 'user');
  const lastUserMsg = userMsgs[userMsgs.length - 1];
  const lastText = lastUserMsg ? serializeMessageContent(lastUserMsg).trim() : fallbackContent;

  const isConfirmation =
    // 2026-10-28 (P3): chỉ nhận xác nhận EXACT — bỏ heuristic prefix ("/^(?:đúng|ok|tiếp|làm...)/
    // với text ≤20 ký tự) vì "ok cancel that" hay "làm lại từ đầu đi" (mệnh lệnh MỚI) từng bị
    // rewrite thành continuation của yêu cầu cũ, làm sai lệch ý người dùng.
    /^(?:đúng rồi|đúng|đúng v|chuẩn|chuẩn rồi|chính xác|ok|okie|oke|tiếp tục|làm đi|làm tiếp|triển khai đi|yes|yep|sure|go ahead|proceed|y)[.!]?$/i.test(lastText);

  let effectiveContent = lastText;
  if (isConfirmation && userMsgs.length >= 2) {
    const prevUserMsg = userMsgs[userMsgs.length - 2];
    const prevText = serializeMessageContent(prevUserMsg).trim();
    effectiveContent = `[CONVERSATION CONTINUATION]: The user previously requested: "${prevText}". Now the user confirms: "${lastText}". Proceed to address and execute the user's previous request.`;
  }

  const isConsultation =
    /(?:gợi ý|ý kiến|tư vấn|nghĩ sao|như thế nào|thế nào|được không|có cách nào|suggest|recommend|roadmap|architecture|advice|what do you think|how should)/i.test(lastText);

  return {
    content: effectiveContent,
    rawText: lastText,
    isConsultation,
    isConfirmation,
  };
}

export function sanitizeMessagesForUpstream(messages, fallbackPrompt, toolsPrompt, maxBudgetChars = 120000) {
  let clean = [];
  if (Array.isArray(messages) && messages.length > 0) {
    for (const m of messages) {
      if (!m) continue;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      let content = serializeMessageContent(m);
      if (!content || !content.trim()) continue;
      content = cleanTruncateMessage(content, 45000);
      clean.push({ role, content });
    }
  }

  if (clean.length === 0) {
    clean = [{ role: 'user', content: fallbackPrompt || 'Hello' }];
  }

  // Budget trimming: if conversation history is excessively long, preserve first message (system/tools) + most recent messages
  let totalChars = clean.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars > maxBudgetChars && clean.length > 3) {
    const firstMsg = clean[0];
    const recent = [];
    let rem = maxBudgetChars - firstMsg.content.length;
    for (let i = clean.length - 1; i >= 1; i--) {
      const len = clean[i].content.length;
      if (rem >= len || recent.length < 2) {
        recent.unshift(clean[i]);
        rem -= len;
      } else {
        break;
      }
    }
    clean = [firstMsg, ...recent];
  }

  if (toolsPrompt && clean.length > 0) {
    const hasCard = clean[0].content.includes('[Available tools]') || clean[0].content.includes('[AVAILABLE TOOLS]');
    if (!hasCard) {
      clean[0].content = `${toolsPrompt}\n\n${clean[0].content}`;
    }
  }

  return clean;
}

export function parseToolCallsFromText(text, availableTools = [], ideType = 'unknown') {
  if (!text || typeof text !== "string") return null;
  // SAFETY 2026-10-28: client không khai báo tool nào → không tồn tại tool để gọi.
  // Mọi JSON/XML tool-call nhúng trong văn bản lúc này chỉ là ví dụ minh họa hoặc
  // prompt-injection; tuyệt đối không extract thành call thật và không cắt reply.
  if (!Array.isArray(availableTools) || availableTools.length === 0) return null;

  // 1. Thử extractTextToolCalls đa định dạng (XML, antml, Cline tags, JSON envelopes, bracket calls)
  const extracted = extractTextToolCalls(text);
  if (Array.isArray(extracted) && extracted.length > 0) {
    const first = extracted[0];
    const preText = extractPreToolText(text);
    return {
      text: preText,
      calls: extracted,
      name: first.name,
      input: first.arguments || {},
      id: first.id,
      rawCall: text,
    };
  }

  // 2. Bracket syntax: [Tool Call: name(...)] or [Function Call: name(...)]
  const regex1 = /\[(?:Tool|Function)?\s*Call:\s*([a-zA-Z0-9_\-\.]+)\s*\(([\s\S]*?)\)\]/i;
  const match1 = text.match(regex1);
  if (match1) {
    const rawName = match1[1].trim();
    const rawArgs = match1[2].trim();
    let parsedArgs = {};
    try { parsedArgs = rawArgs ? JSON.parse(rawArgs) : {}; } catch { parsedArgs = { raw: rawArgs }; }
    const textBefore = extractPreToolText(text);
    const callObj = { name: rawName, arguments: parsedArgs, id: `call_${Date.now().toString(36)}` };
    return { text: textBefore, name: rawName, input: parsedArgs, calls: [callObj], rawCall: match1[0] };
  }

  // 3. XML tag syntax: <tool_call>...</tool_call>
  const regex2 = /<tool_call>([\s\S]*?)<\/tool_call>/i;
  const match2 = text.match(regex2);
  if (match2) {
    try {
      const obj = JSON.parse(match2[1].trim());
      if (obj && (obj.name || obj.tool)) {
        const name = obj.name || obj.tool;
        const input = obj.arguments || obj.input || obj.parameters || {};
        const callObj = { name, arguments: input, id: `call_${Date.now().toString(36)}` };
        return { text: extractPreToolText(text), name, input, calls: [callObj], rawCall: match2[0] };
      }
    } catch {}
  }

  // 4. Markdown code block: ```json ... ``` or ```tool_call ... ```
  const regex3 = /```(?:json|tool_call)?\s*(\{\s*"name"\s*:\s*"[a-zA-Z0-9_\-\.]+"[\s\S]*?\})\s*```/i;
  const match3 = text.match(regex3);
  if (match3) {
    try {
      const obj = JSON.parse(match3[1].trim());
      if (obj && obj.name) {
        const input = obj.arguments || obj.input || obj.parameters || {};
        const callObj = { name: obj.name, arguments: input, id: `call_${Date.now().toString(36)}` };
        return { text: extractPreToolText(text), name: obj.name, input, calls: [callObj], rawCall: match3[0] };
      }
    } catch {}
  }

  return null;
}

export function extractReplyText(parsed) {
  const req = parsed?.data?.aiRequest || parsed?.data?.aiResult;
  const completion = typeof req?.completionString === 'string' && req.completionString.trim()
    ? req.completionString.trim()
    : typeof req?.completion === 'string' && req.completion.trim()
    ? req.completion.trim()
    : typeof req?.text === 'string' && req.text.trim()
    ? req.text.trim()
    : typeof req?.answer === 'string' && req.answer.trim()
    ? req.answer.trim()
    : '';

  const reasoning = typeof req?.reasoning === 'string' && req.reasoning.trim()
    ? req.reasoning.trim()
    : '';

  if (completion && reasoning) {
    return `<thinking>\n${reasoning}\n</thinking>\n\n${completion}`;
  }
  if (completion) return completion;
  if (reasoning) return reasoning;

  if (typeof parsed?.data?.completionString === 'string' && parsed.data.completionString.trim()) {
    return parsed.data.completionString.trim();
  }
  return '';
}

export function getClickUpFallbackModels(resolvedModel) {
  // resolvedModel luôn là id post-alias ('claude-opus-5-5' | 'google/gemini-4-argon') —
  // các nhánh gpt-luna/sol/astra của bản cũ là dead code vì không bao giờ nhận giá trị này.
  // Candidate phải là id ClickUp chấp nhận thật; 'claude-opus-5' (alias key, không phải id
  // upstream) đã bị loại khỏi chuỗi để không đốt một attempt vô ích.
  const fallbacks = [resolvedModel];
  if (resolvedModel === 'google/gemini-4-argon') {
    fallbacks.push('google/gemini-3.8-flash', 'claude-sonnet-5-5');
  } else {
    fallbacks.push('gpt-6.1-sol', 'claude-sonnet-5-5', 'gpt-6-luna');
  }
  return [...new Set(fallbacks)];
}

export async function executeClickUpWithFallback({ payload, workspaceId, sessionKey, signal, initialModel }) {
  const candidates = getClickUpFallbackModels(initialModel);
  let lastResult = null;
  let lastError = null;
  // Candidate hiện tại dùng payload riêng: nén ngữ cảnh sau 1 completion rỗng
  // KHÔNG được đột biến payload gốc (caller cần đủ lịch sử).
  let activePayload = payload;

  for (let i = 0; i < candidates.length; i++) {
    signal?.throwIfAborted();
    const candidate = candidates[i];
    if (activePayload?.variables?.input) {
      activePayload.variables.input.model = candidate;
      activePayload.variables.input.selectedModel = candidate;
    }

    try {
      const res = await executePooledUpstream({ payload: activePayload, workspaceId, sessionKey, signal });
      const aiRequestErrors = res.parsed?.data?.aiRequest?.errors;
      if (Array.isArray(aiRequestErrors) && aiRequestErrors.length > 0) {
        const errMsg = aiRequestErrors.map((e) => e?.message || e?.code || JSON.stringify(e)).join('; ');
        console.warn(`[ClickUpUpstream] Model ${candidate} trả về lỗi GraphQL: ${errMsg}`);
        if (i === candidates.length - 1) {
          throw new Error(`ClickUp AI error: ${errMsg}`);
        }
        continue;
      }

      const text = extractReplyText(res.parsed);
      if (text) {
        return { ...res, replyText: text, usedModel: candidate };
      }

      lastResult = res;
      const safeLen = (v) => {
        if (v == null) return 0;
        if (typeof v === 'string' || Array.isArray(v)) return v.length;
        try { return JSON.stringify(v).length; } catch { return -1; }
      };
      // 2026-10-28 (P3): chỉ log shape (tên field + kiểu + độ dài), không log nội dung.
      const preview = Object.entries(res.parsed?.data?.aiRequest || res.parsed || {})
        .map(([k, v]) => `${k}:${typeof v}(${safeLen(v)})`)
        .join(',');
      console.warn(`[ClickUpUpstream] Model ${candidate} trả về completion rỗng (${preview}). Đang nén ngữ cảnh và thử model thay thế...`);

      // Tự thu gọn lịch sử cho ỨNG VIÊN TIẾP THEO trên bản sao payload cục bộ
      if (activePayload?.variables?.input?.messages?.length > 3) {
        const msgs = activePayload.variables.input.messages;
        const compactInput = { ...activePayload.variables.input, messages: [msgs[0], ...msgs.slice(-2)] };
        if ((compactInput.maxTokens || 0) > 2048) compactInput.maxTokens = 2048;
        activePayload = { ...activePayload, variables: { ...activePayload.variables, input: compactInput } };
      } else if ((activePayload?.variables?.input?.maxTokens || 0) > 2048) {
        activePayload = {
          ...activePayload,
          variables: { ...activePayload.variables, input: { ...activePayload.variables.input, maxTokens: 2048 } },
        };
      }
    } catch (err) {
      signal?.throwIfAborted();
      lastError = err;
      // Pool cạn kiệt toàn cục: trạng thái pool ảnh hưởng mọi model — không thử candidate nào nữa.
      if (err?.code === 'POOL_EXHAUSTED' || String(err?.message || '').includes('Tất cả Workspace ClickUp trong Pool')) {
        throw err;
      }
      if (i === candidates.length - 1) throw err;
      console.warn(`[ClickUpUpstream] Model ${candidate} gặp lỗi (${err.message}). Thử candidate tiếp theo...`);
    }
  }

  throw lastError || new Error('ClickUp returned empty completions for all candidate models');
}

/**
 * executePooledUpstream - Sends GraphQL AIRequest to ClickUp Gateway with automatic multi-workspace failover
 */
export async function executePooledUpstream({ payload, headers = {}, workspaceId = null, sessionKey = null, signal = null }) {
  let lastError = null;
  const enabledWorkspaces = clickupPool.workspaces.filter((w) => w.enabled);
  const attempts = Math.max(1, enabledWorkspaces.length);
  const triedWorkspaceIds = [];

  const isRetryableError = (rawMsg) => {
    const msg = String(rawMsg || '').toLowerCase();
    return (
      msg.includes('429') ||
      msg.includes('quota') ||
      msg.includes('fairuseblocked') ||
      msg.includes('usage_quota_exceeded') ||
      /http\s+40[13]\b/.test(msg) ||
      /http\s+50[234]\b/.test(msg)
    );
  };

  for (let attempt = 0; attempt < attempts; attempt++) {
    let acquired = null;
    let usedWorkspace = null;
    // Mỗi lần thử chỉ báo lỗi cho pool đúng một lần (nhánh cụ thể và catch không cộng dồn).
    let reported = false;
    const reportAttemptError = (error, statusCode = null) => {
      if (reported || !usedWorkspace) return;
      reported = true;
      clickupPool.reportError(usedWorkspace, error, statusCode);
    };
    // Phát sự kiện quan sát cho HTTP 429/5xx thực tế, kể cả khi failover sau đó thành công.
    const emitHttpError = (status) => {
      alertEvents.emit(ALERT_EVENTS.UPSTREAM_HTTP_ERROR, {
        workspaceId: usedWorkspace?.workspaceId,
        workspace: usedWorkspace?.label,
        status,
      });
    };

    try {
      acquired = await clickupPool.acquire({
        preferredWorkspaceId: workspaceId,
        sessionKey,
        signal,
        excludeWorkspaceIds: triedWorkspaceIds,
      });
      usedWorkspace = acquired.workspace;
      if (usedWorkspace?.workspaceId) {
        triedWorkspaceIds.push(usedWorkspace.workspaceId);
      }

      const exchanged = await clickupPool.getGatewayToken(usedWorkspace);
      const activeToken = exchanged.token;
      const targetUrl = exchanged.url || 'https://frontdoor-search.clickup-sg.com/graphql/gateway';

      if (payload?.variables?.input) {
        payload.variables.input.workspaceId = usedWorkspace.workspaceId;
      }

      const body = JSON.stringify(payload);
      const target = new URL(targetUrl);
      const transport = target.protocol === 'http:' ? http : https;

      const res = await new Promise((resolve, reject) => {
        const req = transport.request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || undefined,
            path: target.pathname + target.search,
            method: 'POST',
            agent: target.protocol === 'http:' ? httpAgent : httpsAgent,
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
              authorization: `Bearer ${activeToken}`,
              Origin: 'https://app.clickup.com',
              Referer: 'https://app.clickup.com/',
              'clickup-surface': 'client',
              'clickup-client-version': '3.83.0',
              ...headers,
            },
            signal,
            timeout: 120000,
          },
          (upstreamRes) => {
            const chunks = [];
            upstreamRes.on('data', (c) => chunks.push(c));
            // 2026-10-28: thiếu error handler khiến response upstream hỏng giữa chừng
            // (content-length lệch, premature close) → unhandled 'error' → crash process.
            upstreamRes.on('error', reject);
            upstreamRes.on('end', () => {
              resolve({
                status: upstreamRes.statusCode ?? 502,
                headers: upstreamRes.headers,
                text: Buffer.concat(chunks).toString('utf8'),
              });
            });
          }
        );

        req.on('timeout', () => req.destroy(new Error('ClickUp upstream timeout after 120s')));
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      if (res.status === 401 || res.status === 403) {
        usedWorkspace.gatewayCache = null;
        reportAttemptError(`HTTP ${res.status} from gateway`, res.status);
        throw new Error(`HTTP ${res.status} from upstream gateway`);
      }

      if (res.status === 429) {
        emitHttpError(429);
        reportAttemptError('HTTP 429 Rate Limit', 429);
        throw new Error('HTTP 429 Rate Limit from upstream provider');
      }

      if (res.status >= 500 && res.status <= 599) {
        emitHttpError(res.status);
        reportAttemptError(`HTTP ${res.status} from ClickUp gateway`, res.status);
        throw new Error(`HTTP ${res.status} from ClickUp gateway`);
      }

      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ClickUp gateway`);
      let parsed = null;
      try {
        parsed = JSON.parse(res.text);
      } catch {}

      if (!parsed) throw new Error('Invalid JSON from ClickUp gateway');
      const errors = parsed?.data?.aiRequest?.errors;
      const hasModelDisabled = Array.isArray(errors) && errors.some((e) => /ai_model_disabled|premium_models_not_entitled|not entitled/i.test(e?.code || e?.message || ''));
      if (hasModelDisabled) {
        const dErr = errors.map(e => e?.message || e?.code).join('; ');
        reportAttemptError(`AI_MODEL_DISABLED: ${dErr}`, 403);
        if (attempt + 1 < attempts) {
          console.warn(`[ClickUpPool] Workspace "${usedWorkspace.label}" (${usedWorkspace.workspaceId}) model disabled/expired. Auto-failing over...`);
          continue;
        }
        throw new Error(`ClickUp AI model disabled or trial expired: ${dErr}`);
      }

      if (Array.isArray(errors) && errors.some((e) => e?.code === 'USAGE_QUOTA_EXCEEDED')) {
        reportAttemptError('USAGE_QUOTA_EXCEEDED', 429);
        if (attempt + 1 < attempts) {
          console.warn(`[ClickUpPool] Workspace "${usedWorkspace.label}" (${usedWorkspace.workspaceId}) chạm quota ngày (USAGE_QUOTA_EXCEEDED). Tự động failover sang workspace khác (lần thử ${attempt + 2}/${attempts})...`);
          continue;
        }
        throw new Error('ClickUp AI quota exceeded on all available workspaces: USAGE_QUOTA_EXCEEDED');
      }

      if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
        const errorDetail = parsed.errors.map((e) => e?.message || JSON.stringify(e)).join('; ');
        const isModelDisabled = /ai_model_disabled|premium_models_not_entitled|not entitled/i.test(errorDetail);
        if (isModelDisabled) {
          reportAttemptError(errorDetail, 403);
          if (attempt + 1 < attempts) {
            console.warn(`[ClickUpPool] Workspace "${usedWorkspace.label}" model disabled/expired (${errorDetail}). Auto-failing over...`);
            continue;
          }
        }
        const isTemporary = /internal server error|timeout|unavailable|gateway|status 5/i.test(errorDetail);
        if (isTemporary) {
          reportAttemptError(`GraphQL Error: ${errorDetail}`, 500);
          if (attempt + 1 < attempts) {
            console.warn(`[ClickUpPool] Workspace "${usedWorkspace.label}" temporary error (${errorDetail}). Auto-failing over...`);
            continue;
          }
        }
        throw new Error(`ClickUp upstream GraphQL error: ${errorDetail}`);
      }

      const replyText = extractReplyText(parsed);
      if (replyText) {
        const inTokens = estimateTokens(payload?.variables?.input?.prompt || '');
        const outTokens = estimateTokens(replyText);
        clickupPool.reportSuccess(usedWorkspace, inTokens + outTokens);
      }
      return { ...res, parsed, workspace: usedWorkspace };
    } catch (err) {
      signal?.throwIfAborted();
      lastError = err;
      reportAttemptError(err);
      // Pool cạn kiệt toàn cục: acquire đã duyệt hết workspace khả dụng —
      // retry thêm trong cùng chuỗi chỉ lặp lại cùng lỗi.
      if (err?.code === 'POOL_EXHAUSTED' || String(err?.message || '').includes('Tất cả Workspace ClickUp trong Pool')) {
        throw err;
      }
      const isRetryable = isRetryableError(err.message || '');
      if (isRetryable && attempt + 1 < attempts) {
        console.warn(`[ClickUpPool] Request hit retryable error (${err.message}). Auto-failing over...`);
        continue;
      }
      throw err;
    } finally {
      if (acquired) acquired.release();
    }
  }
  throw lastError;
}

/**
 * handleClickUpRequest - Unified request handler for SharkPool
 */
export function splitThinkingAndContent(text) {
  if (!text || typeof text !== 'string') return { thinking: '', content: '' };
  const match = text.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (match) {
    const thinking = match[1].trim();
    const content = text.replace(/<thinking>[\s\S]*?<\/thinking>/i, '').trim();
    return { thinking, content };
  }
  return { thinking: '', content: text };
}

/**
 * 2026-10-28 (fix "lệnh trước không trả kết quả"): khi model "diễn kịch" — phát
 * tool-call markup nhái format lạ (vd <invoke name="functions.exec">) hoặc TỰ BỊA
 * kết quả thực thi bằng khối <system>Tool ran without output...</system> — mọi call
 * như vậy đều bị mapper loại (tên không có trong catalog) vàmarkup không được stream.
 * Nhưng phần văn bản vẫn leak về client như prose. Hàm này làm sạch các khối giả đó
 * trước khi phát text, giữ lại phần giải thích thật của model.
 */
export function stripPseudoToolMarkup(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, '')
    .replace(/<invoke[^>]*\/>/gi, '')
    .replace(/<tool_call[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<system>[\s\S]*?<\/system>/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Thông báo lỗi trung tính cho client: không lộ tên backend hay message nội bộ.
// Chi tiết gốc vẫn được ghi ở console/diagnostics phía server.
function buildNeutralUpstreamError(err, requestId) {
  const raw = Number(err?.retryAfterSeconds);
  const retryAfterSeconds = Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : null;
  const ref = requestId ? ` Mã tra cứu: ${requestId}` : '';
  let message;
  if (err?.code === 'POOL_EXHAUSTED') {
    message = retryAfterSeconds
      ? `Dịch vụ tạm thời chưa có tài nguyên khả dụng. Vui lòng thử lại sau khoảng ${retryAfterSeconds} giây.${ref}`
      : `Dịch vụ tạm thời chưa có tài nguyên khả dụng. Vui lòng thử lại sau.${ref}`;
  } else {
    message = `Dịch vụ tạm thời gặp sự cố khi xử lý yêu cầu. Vui lòng thử lại.${ref}`;
  }
  return { message, retryAfterSeconds };
}

export async function handleClickUpRequest({ req, res, rawBody, route, config, signal, diagnostics, requestedModel, requestId }) {
  const isChatRoute = route.includes('/chat/completions') || rawBody?.protocol === 'openai' || rawBody?.isChat;
  const isResponsesRoute = route.includes('/responses') || rawBody?.isResponses;
  const wantsStream = Boolean(rawBody?.stream);
  const responsesContext = isResponsesRoute ? createResponsesContext(requestId) : null;

  let rawMessages = Array.isArray(rawBody?.messages) ? rawBody.messages : [];
  if (rawBody?.system && Array.isArray(rawMessages) && !rawMessages.some((m) => m.role === 'system')) {
    const sysContent = serializeMessageContent({ content: rawBody.system });
    rawMessages.unshift({ role: 'system', content: sysContent });
  }

  const prompt = messagesToPrompt(rawMessages);
  if (!prompt && (!rawBody?.prompt || !String(rawBody.prompt).trim())) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '`messages` must be a non-empty array with content.', type: 'invalid_request_error' } }));
    return;
  }

  const resolvedModel = resolveClickUpModel(requestedModel || rawBody?.model);
  diagnostics.model = CLICKUP_MODELS.some(id => resolveClickUpModel(id) === resolvedModel) ? resolvedModel : 'other';
  diagnostics.upstreamProvider = 'clickup';

  const availableTools = Array.isArray(rawBody?.tools)
    ? rawBody.tools
    : Array.isArray(rawBody?.functions)
    ? rawBody.functions
    : [];
  const ideType = detectIDE(req.headers, availableTools) || 'unknown';
  const toolMapper = createClickUpToolMapper(ideType, availableTools);
  res.setHeader('x-proxy-ide', ideType);
  // 2026-10-28: cho client/operator thấy request CÓ gửi tool catalog hay không —
  // 0 tools = model là chat thuần, sẽ trả lời "không có công cụ" khi được yêu cầu
  // đọc file/chạy lệnh (đó là hành vi đúng của model, không phải lỗi gateway).
  res.setHeader('x-proxy-tools', String(availableTools.length));

  const toolsPrompt = formatToolsPrompt(availableTools, ideType);
  const fullPrompt = toolsPrompt ? `${toolsPrompt}\n\n${prompt}` : prompt;
  if (diagnostics) {
    diagnostics.inputTokens = estimateTokens(fullPrompt);
  }

  // Extract active intent & current turn prompt (Auto-link history for short confirmations and handle advisory questions)
  const intent = resolveActiveUserIntent(rawMessages, rawBody?.prompt || prompt || 'Hello');
  const currentTurnContent = intent.content;

  let currentTurnPrompt = currentTurnContent;

  const sanitizedMessages = sanitizeMessagesForUpstream(rawMessages, fullPrompt, toolsPrompt);

  let requestedMaxTokens = Number(rawBody?.max_tokens || rawBody?.max_completion_tokens || 8192);
  const estInTokens = estimateTokens(fullPrompt);
  if (estInTokens > 16000) {
    // 2026-10-28 (fix "lệnh trước không trả kết quả"): sàn 1024 khiến reply bị đứt
    // GIỮA tool-call JSON khi prompt lớn → parser khôi phục được name nhưng MẤT
    // arguments → call bị loại → model chờ result mãi. Sàn 4096 đủ cho một tool
    // call JSON hoàn chỉnh (thường < 4KB) trong trường hợp prompt cực lớn.
    requestedMaxTokens = Math.min(requestedMaxTokens, Math.max(4096, 30000 - estInTokens));
  }

  const input = {
    model: resolvedModel,
    selectedModel: resolvedModel,
    prompt: currentTurnPrompt,
    text: currentTurnPrompt,
    messages: sanitizedMessages,
    workspaceId: clickupPool.defaults.workspaceId || '',
    maxTokens: requestedMaxTokens,
  };

  const payload = {
    operationName: 'AIRequest',
    variables: {
      type: 'CHAT_COMPLETION',
      input,
    },
    query: `query AIRequest($type: AIRequestType!, $input: JSONObject!) {
  aiRequest(type: $type, input: $input) {
    completionString
    reasoning
    errors
  }
}`,
  };

  const requestedWs = req.headers['x-workspace-id'] || null;
  const sessionKey = computeSessionKey(req, rawBody);

  if (wantsStream) {
    req.socket?.setNoDelay(true);
    res.socket?.setNoDelay(true);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
      'x-proxy-upstream-provider': 'clickup',
      'x-proxy-upstream-model': resolvedModel,
    });
    res.flushHeaders?.();

    const writeSse = (event, data) => {
      if (res.writableEnded || res.destroyed) return;
      if (event) res.write(`event: ${event}\n`);
      res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };

    let responseSequence = 0;
    const writeResponseEvent = (type, data = {}) => {
      writeSse(type, { type, sequence_number: responseSequence++, ...data });
    };

    // Immediate keep-alive
    res.write(': keep-alive\n\n');

    let heartbeatTimer = setInterval(() => {
      try {
        if (!res.writableEnded) res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeatTimer);
      }
    }, 3000);

    const cleanup = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    res.on('close', cleanup);

    try {
      if (isResponsesRoute) {
        const response = buildResponsesResponse({
          context: responsesContext,
          rawBody,
          model: requestedModel || resolvedModel,
          status: 'in_progress',
        });
        writeResponseEvent('response.created', { response });
        writeResponseEvent('response.in_progress', { response });
      } else if (isChatRoute) {
        writeSse(null, {
          id: `chatcmpl-${requestId}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: requestedModel || resolvedModel,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        });
      } else {
        // Anthropic message_start
        writeSse('message_start', {
          type: 'message_start',
          message: {
            id: `msg_${requestId}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: requestedModel || resolvedModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: diagnostics?.inputTokens ?? 15, output_tokens: 1 },
          },
        });
        // Content block start deferred to actual stream delivery
      }

      const upstreamStartedAt = performance.now();
      let upstreamResult = await executeClickUpWithFallback({
        payload,
        workspaceId: requestedWs,
        sessionKey,
        signal,
        initialModel: resolvedModel,
      });
      // 2026-10-28 (P3): đo TTFT thật (thời gian chờ upstream lần đầu), không còn
      // field chết trong request log.
      if (diagnostics && diagnostics.ttftMs === undefined) {
        diagnostics.ttftMs = Math.round(performance.now() - upstreamStartedAt);
      }
      if (diagnostics) diagnostics.workspaceId = upstreamResult.workspace?.workspaceId || upstreamResult.workspace?.id || null;

      let actualModel = upstreamResult.usedModel || resolvedModel;
      if (diagnostics) diagnostics.model = CLICKUP_MODELS.some(id => resolveClickUpModel(id) === actualModel) ? actualModel : 'other';
      let replyText = upstreamResult.replyText;
      if (diagnostics) {
        diagnostics.outputTokens = replyText ? estimateTokens(replyText) : 1;
      }
      let parsedTool = parseToolCallsFromText(replyText, availableTools, ideType);
      let toolCalls = [];
      if (parsedTool?.calls?.length) {
        toolCalls = parsedTool.calls.map(c => toolMapper.map(c)).filter(Boolean);
      } else if (parsedTool) {
        const single = toolMapper.map(parsedTool);
        if (single) toolCalls = [single];
      }
      let toolCall = toolCalls[0] || null;
      const preText = parsedTool?.text !== undefined ? parsedTool.text : extractPreToolText(replyText);
      if (toolCall) {
        toolCall.text = preText;
      }

      // Split thinking (reasoning) and content
      const { thinking: replyThinking, content: replyContent } = splitThinkingAndContent(replyText);
      const textToStream = toolCalls.length > 0
        ? (preText || '')
        : stripPseudoToolMarkup(replyContent);

      // Tắt heartbeat chỉ khi sẵn sàng bơm chunk thật.
      cleanup();

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      // Adaptive typewriter pacing based on text length
      const totalLen = (replyThinking ? replyThinking.length : 0) + (textToStream ? textToStream.length : 0);
      const chunkSize = totalLen > 8000 ? 64 : (totalLen > 3000 ? 40 : 20);
      const delayMs = Math.max(5, Math.min(18, Math.floor(1000 / Math.max(1, totalLen / chunkSize))));

      if (isResponsesRoute) {
        const responseText = toolCalls.length > 0 ? (preText || '') : stripPseudoToolMarkup(replyContent || replyText || '');
        const output = buildResponsesOutput({
          context: responsesContext,
          text: responseText,
          toolCalls,
        });

        for (let outputIndex = 0; outputIndex < output.length; outputIndex++) {
          if (res.writableEnded || signal?.aborted) break;
          const item = output[outputIndex];
          if (item.type === 'message') {
            const part = item.content[0];
            writeResponseEvent('response.output_item.added', {
              output_index: outputIndex,
              item: { ...item, status: 'in_progress', content: [] },
            });
            writeResponseEvent('response.content_part.added', {
              item_id: item.id,
              output_index: outputIndex,
              content_index: 0,
              part: { ...part, text: '' },
            });
            for (let i = 0; i < part.text.length; i += chunkSize) {
              if (res.writableEnded || signal?.aborted) break;
              writeResponseEvent('response.output_text.delta', {
                item_id: item.id,
                output_index: outputIndex,
                content_index: 0,
                delta: part.text.slice(i, i + chunkSize),
                logprobs: [],
              });
              await sleep(delayMs);
            }
            writeResponseEvent('response.output_text.done', {
              item_id: item.id,
              output_index: outputIndex,
              content_index: 0,
              text: part.text,
              logprobs: [],
            });
            writeResponseEvent('response.content_part.done', {
              item_id: item.id,
              output_index: outputIndex,
              content_index: 0,
              part,
            });
          } else if (item.type === 'function_call') {
            writeResponseEvent('response.output_item.added', {
              output_index: outputIndex,
              item: { ...item, status: 'in_progress', arguments: '' },
            });
            const argumentChunkSize = 128;
            for (let i = 0; i < item.arguments.length; i += argumentChunkSize) {
              if (res.writableEnded || signal?.aborted) break;
              writeResponseEvent('response.function_call_arguments.delta', {
                item_id: item.id,
                output_index: outputIndex,
                delta: item.arguments.slice(i, i + argumentChunkSize),
              });
            }
            writeResponseEvent('response.function_call_arguments.done', {
              item_id: item.id,
              output_index: outputIndex,
              arguments: item.arguments,
            });
          }
          writeResponseEvent('response.output_item.done', { output_index: outputIndex, item });
        }

        if (!res.writableEnded) {
          rememberResponsesConversation({
            responseId: responsesContext.responseId,
            messages: rawMessages,
            output,
          });
          const response = buildResponsesResponse({
            context: responsesContext,
            rawBody,
            model: requestedModel || resolvedModel,
            output,
            usage: buildResponsesUsage(diagnostics?.inputTokens, diagnostics?.outputTokens),
          });
          writeResponseEvent('response.completed', { response });
          res.end();
        }
      } else if (isChatRoute) {
        // 1. Stream reasoning if present
        if (replyThinking) {
          for (let i = 0; i < replyThinking.length; i += chunkSize) {
            if (res.writableEnded || signal?.aborted) break;
            const chunk = replyThinking.slice(i, i + chunkSize);
            writeSse(null, {
              id: `chatcmpl-${requestId}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestedModel || resolvedModel,
              choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }],
            });
            await sleep(delayMs);
          }
        }

        // 2. Stream content
        for (let i = 0; i < textToStream.length; i += chunkSize) {
          if (res.writableEnded || signal?.aborted) break;
          const chunk = textToStream.slice(i, i + chunkSize);
          writeSse(null, {
            id: `chatcmpl-${requestId}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: requestedModel || resolvedModel,
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          });
          await sleep(delayMs);
        }

        if (!res.writableEnded) {
          if (toolCalls.length > 0) {
            writeSse(null, {
              id: `chatcmpl-${requestId}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestedModel || resolvedModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: toolCalls.map((tc, idx) => ({
                      index: idx,
                      id: tc.id || `call_${requestId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}_${idx}`,
                      type: 'function',
                      function: {
                        name: tc.name,
                        arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
                      },
                    })),
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            });
          } else {
            writeSse(null, {
              id: `chatcmpl-${requestId}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestedModel || resolvedModel,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
          }
          if (rawBody?.stream_options?.include_usage) {
            writeSse(null, {
              id: `chatcmpl-${requestId}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: requestedModel || resolvedModel,
              choices: [],
              usage: {
                prompt_tokens: diagnostics?.inputTokens || 0,
                completion_tokens: diagnostics?.outputTokens || 0,
                total_tokens: (diagnostics?.inputTokens || 0) + (diagnostics?.outputTokens || 0),
              },
            });
          }
          writeSse(null, '[DONE]');
          res.end();
        }
      } else {
        // Anthropic protocol
        let currentBlockIndex = 0;

        // 1. Stream thinking if present and requested
        const wantsThinking = rawBody?.thinking?.type === 'enabled' || Boolean(config?.thinkingEnabled);
        if (replyThinking && wantsThinking) {
          writeSse('content_block_start', {
            type: 'content_block_start',
            index: currentBlockIndex,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          });

          for (let i = 0; i < replyThinking.length; i += chunkSize) {
            if (res.writableEnded || signal?.aborted) break;
            const chunk = replyThinking.slice(i, i + chunkSize);
            writeSse('content_block_delta', {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'thinking_delta', thinking: chunk },
            });
            await sleep(delayMs);
          }

          writeSse('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
          currentBlockIndex++;
        }

        // 2. Stream main text block
        const textToEmit = (replyThinking && !wantsThinking && toolCalls.length === 0)
          ? `${replyThinking}\n\n${textToStream}`
          : textToStream;

        if (textToEmit || toolCalls.length === 0) {
          writeSse('content_block_start', {
            type: 'content_block_start',
            index: currentBlockIndex,
            content_block: { type: 'text', text: '' },
          });

          for (let i = 0; i < textToEmit.length; i += chunkSize) {
            if (res.writableEnded || signal?.aborted) break;
            const chunk = textToEmit.slice(i, i + chunkSize);
            writeSse('content_block_delta', {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'text_delta', text: chunk },
            });
            await sleep(delayMs);
          }

          writeSse('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
          currentBlockIndex++;
        }

        // 3. Emit tool calls if present
        if (!res.writableEnded) {
          if (toolCalls.length > 0) {
            for (let i = 0; i < toolCalls.length; i++) {
              const tc = toolCalls[i];
              const toolId = tc.id || ('toolu_' + requestId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) + `_${i}`);
              writeSse('content_block_start', {
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: { type: 'tool_use', id: toolId, name: tc.name, input: {} },
              });
              const rawJson = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {});
              const jsonChunkSize = 128;
              if (rawJson.length > jsonChunkSize) {
                for (let j = 0; j < rawJson.length; j += jsonChunkSize) {
                  if (res.writableEnded || signal?.aborted) break;
                  writeSse('content_block_delta', {
                    type: 'content_block_delta',
                    index: currentBlockIndex,
                    delta: {
                      type: 'input_json_delta',
                      partial_json: rawJson.slice(j, j + jsonChunkSize),
                    },
                  });
                  if (j + jsonChunkSize < rawJson.length) await sleep(2);
                }
              } else {
                writeSse('content_block_delta', {
                  type: 'content_block_delta',
                  index: currentBlockIndex,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: rawJson,
                  },
                });
              }
              writeSse('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex });
              currentBlockIndex++;
            }
            writeSse('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use', stop_sequence: null },
              usage: { output_tokens: diagnostics?.outputTokens || Math.max(1, Math.round(replyText.length / 4)) },
            });
          } else {
            writeSse('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: diagnostics?.outputTokens || Math.max(1, Math.round(replyText.length / 4)) },
            });
          }
          writeSse('message_stop', { type: 'message_stop' });
          res.end();
        }
      }
    } catch (err) {
      cleanup();
      // HTTP status is already 200 for SSE, so the diagnostics outcome must be set explicitly.
      if (diagnostics) diagnostics.outcome = signal?.aborted ? 'aborted' : 'error';
      console.error('[ClickUpUpstream] Lỗi stream:', err.message);
      if (!res.writableEnded && !res.destroyed) {
        // POOL_EXHAUSTED: chỉ 429 khi pool cạn do QUOTA; circuit breaker/rate-limit là lỗi
        // phía upstream → 502. Các lỗi khác giữ heuristic regex trên message.
        const quotaLike = err?.quotaExhausted === true ||
          (err?.code !== 'POOL_EXHAUSTED' && /quota|fairuse/i.test(err.message || ''));
        const { message, retryAfterSeconds } = buildNeutralUpstreamError(err, requestId);
        if (isResponsesRoute) {
          const error = {
            code: 'upstream_unavailable',
            message,
            param: null,
          };
          const response = buildResponsesResponse({
            context: responsesContext,
            rawBody,
            model: requestedModel || resolvedModel,
            status: 'failed',
            error,
          });
          writeResponseEvent('response.failed', { response });
        } else if (isChatRoute) {
          writeSse(null, {
            error: {
              message,
              type: quotaLike ? 'insufficient_quota' : 'upstream_error',
              code: 'upstream_unavailable', ...(retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : {}),
              param: null,
            },
          });
          writeSse(null, '[DONE]');
        } else {
          // Dialect Anthropic: event: error + envelope type:'error' là frame kết thúc chuẩn.
          writeSse('error', {
            type: 'error',
            error: { type: quotaLike ? 'rate_limit_error' : 'api_error', message },
          });
        }
        res.end();
      }
    }
  } else {
    // Non-streaming response
    try {
      const upstreamStartedAt = performance.now();
      let upstreamResult = await executeClickUpWithFallback({
        payload,
        workspaceId: requestedWs,
        sessionKey,
        signal,
        initialModel: resolvedModel,
      });
      // 2026-10-28 (P3): đo TTFT thật (thời gian chờ upstream lần đầu), không còn
      // field chết trong request log.
      if (diagnostics && diagnostics.ttftMs === undefined) {
        diagnostics.ttftMs = Math.round(performance.now() - upstreamStartedAt);
      }
      if (diagnostics) diagnostics.workspaceId = upstreamResult.workspace?.workspaceId || upstreamResult.workspace?.id || null;

      let actualModel = upstreamResult.usedModel || resolvedModel;
      if (diagnostics) diagnostics.model = CLICKUP_MODELS.some(id => resolveClickUpModel(id) === actualModel) ? actualModel : 'other';
      let replyText = upstreamResult.replyText;
      if (diagnostics) {
        diagnostics.outputTokens = replyText ? estimateTokens(replyText) : 1;
      }
      let parsedTool = parseToolCallsFromText(replyText, availableTools, ideType);
      let toolCalls = [];
      if (parsedTool?.calls?.length) {
        toolCalls = parsedTool.calls.map(c => toolMapper.map(c)).filter(Boolean);
      } else if (parsedTool) {
        const single = toolMapper.map(parsedTool);
        if (single) toolCalls = [single];
      }
      let toolCall = toolCalls[0] || null;
      const preText = parsedTool?.text !== undefined ? parsedTool.text : extractPreToolText(replyText);
      if (toolCall) {
        toolCall.text = preText;
      }

      const promptTokens = diagnostics?.inputTokens || Math.max(1, Math.round(fullPrompt.length / 4));
      const completionTokens = diagnostics?.outputTokens || Math.max(1, Math.round(replyText.length / 4));

      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('x-proxy-upstream-provider', 'clickup');
      res.setHeader('x-proxy-upstream-model', actualModel);
      // 2026-10-28 (P3): bỏ x-proxy-workspace — header rò rỉ label workspace nội bộ
      // ra mọi client (label chứa workspaceId thật). Nếu cần debug, xem request log.
      if (isResponsesRoute) {
        const { content: responseContent } = splitThinkingAndContent(replyText);
        const responseText = toolCalls.length > 0 ? (preText || '') : stripPseudoToolMarkup(responseContent || replyText || '');
        const output = buildResponsesOutput({
          context: responsesContext,
          text: responseText,
          toolCalls,
        });
        const resp = buildResponsesResponse({
          context: responsesContext,
          rawBody,
          model: requestedModel || resolvedModel,
          output,
          usage: buildResponsesUsage(promptTokens, completionTokens),
        });
        rememberResponsesConversation({
          responseId: responsesContext.responseId,
          messages: rawMessages,
          output,
        });
        res.writeHead(200);
        res.end(JSON.stringify(resp));
      } else if (isChatRoute) {
        const choice = {
          index: 0,
          message: {
            role: "assistant",
            // 2026-10-28: nhánh không-calls làm sạch markup tool giả + khối <system> bịa
            content: toolCalls.length > 0 ? (preText || null) : stripPseudoToolMarkup(replyText)
          },
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop"
        };
        if (toolCalls.length > 0) {
          choice.message.tool_calls = toolCalls.map((tc, idx) => ({
            id: tc.id || `call_${requestId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10)}_${idx}`,
            type: "function",
            function: {
              name: tc.name,
              arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {})
            }
          }));
        }
        const resp = { id: "chatcmpl-" + requestId, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: requestedModel || resolvedModel, choices: [choice], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } };
        res.writeHead(200);
        res.end(JSON.stringify(resp));
      } else {
        // Check if client expects a JSON title object
        // 2026-10-28 (P3): chỉ sniff trong system prompt. Sniff fullPrompt cũ làm
        // reply bình thường bị rewrite thành {"title": ...} khi user dán JSON
        // chứa '{"title":' vào hội thoại.
        const isTitleGen = Boolean(rawBody?.system && JSON.stringify(rawBody.system).includes('Generate a concise title'));
        let finalReplyText = replyText || '';
        if (isTitleGen) {
          finalReplyText = finalReplyText.replace(/```(?:json)?\s*([\s\S]*?)\s*```/i, '$1').trim();
          try {
            const parsedTitle = JSON.parse(finalReplyText);
            if (parsedTitle && typeof parsedTitle.title === 'string') {
              finalReplyText = JSON.stringify({ title: parsedTitle.title });
            } else {
              finalReplyText = JSON.stringify({ title: String(finalReplyText).slice(0, 50) });
            }
          } catch {
            finalReplyText = JSON.stringify({ title: finalReplyText.replace(/[\n\r"]/g, ' ').trim().slice(0, 50) });
          }
        }

        const content = [];
        if (toolCalls.length === 0) {
          content.push({ type: "text", text: stripPseudoToolMarkup(finalReplyText) });
        } else {
          if (preText) content.push({ type: "text", text: preText });
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            const toolId = tc.id || ('toolu_' + requestId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) + `_${i}`);
            content.push({ type: "tool_use", id: toolId, name: tc.name, input: tc.input });
          }
        }
        const resp = { 
          id: "msg_" + requestId, 
          type: "message", 
          role: "assistant", 
          content, 
          model: requestedModel || resolvedModel, 
          stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn", 
          stop_sequence: null, 
          usage: { input_tokens: promptTokens, output_tokens: completionTokens } 
        };
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'x-proxy-upstream-provider': 'clickup',
          'x-proxy-upstream-model': actualModel
        });
        res.end(JSON.stringify(resp));
      }
    } catch (err) {
      if (diagnostics) diagnostics.outcome = signal?.aborted ? 'aborted' : 'error';
      console.error('[ClickUpUpstream] Lỗi non-stream:', err.message);
      const quotaLike = err?.quotaExhausted === true ||
        (err?.code !== 'POOL_EXHAUSTED' && /quota|fairuse/i.test(err.message || ''));
      const { message: clientMessage, retryAfterSeconds } = buildNeutralUpstreamError(err, requestId);
      res.writeHead(quotaLike ? 429 : 502, { 'content-type': 'application/json; charset=utf-8', ...(retryAfterSeconds ? { 'retry-after': String(retryAfterSeconds) } : {}) });
      const errorBody = isChatRoute || isResponsesRoute
        ? {
            error: {
              message: clientMessage,
              type: quotaLike ? 'insufficient_quota' : 'upstream_error',
              code: 'upstream_unavailable',
              ...(retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : {}),
            },
          }
        : {
            type: 'error',
            error: {
              type: quotaLike ? 'rate_limit_error' : 'api_error',
              message: clientMessage,
            },
          };
      res.end(JSON.stringify(errorBody));
    }
  }
}
