/**
 * Partial JSON Repair Buffer
 * Tolerant JSON parser designed for streaming LLM outputs.
 * Repairs unclosed brackets/braces, unescaped quotes, trailing commas,
 * and markdown backtick fences.
 */

export function repairJsonBuffer(raw) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};

  let str = raw.trim();
  if (!str) return {};

  // 1. Direct parse attempt
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return parsed;
  } catch {}

  // 2. Strip markdown fences
  if (str.startsWith('```')) {
    str = str.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      const parsed = JSON.parse(str);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return parsed;
    } catch {}
  }

  // 3. Fix trailing commas and strip control characters
  str = str
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[\u0000-\u001F]+/g, (m) => (m === '\n' || m === '\r' || m === '\t' ? m : ''));

  // 4. Stack-based repair for unclosed strings, objects, and arrays
  let inString = false;
  let isEscaped = false;
  const stack = [];

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (inString) {
      if (char === '\\') {
        isEscaped = !isEscaped;
      } else if (char === '"' && !isEscaped) {
        inString = false;
      } else {
        isEscaped = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{' || char === '[') {
        stack.push(char);
      } else if (char === '}' && stack.at(-1) === '{') {
        stack.pop();
      } else if (char === ']' && stack.at(-1) === '[') {
        stack.pop();
      }
    }
  }

  let repairedStr = str;
  if (inString) repairedStr += '"';
  while (stack.length > 0) {
    const open = stack.pop();
    repairedStr += open === '{' ? '}' : ']';
  }

  try {
    const parsed = JSON.parse(repairedStr);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return parsed;
  } catch {}

  // 5. If JSON is completely malformed, wrap as raw string rather than throwing fatal error
  return { raw_arguments: raw };
}
