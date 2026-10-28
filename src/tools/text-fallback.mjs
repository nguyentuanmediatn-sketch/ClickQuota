/**
 * Text-to-ToolCall Fallback Parser
 * Detects tool invocations embedded in plain text output (XML format or JSON envelope)
 * when upstream returns plain text instead of native toolCallChunk SSE events.
 */

import { randomUUID } from 'node:crypto';
import { repairJsonBuffer } from './json-repair.mjs';

function coerceParamValue(val) {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  try {
    const parsed = JSON.parse(val);
    if (typeof parsed === 'object') return parsed;
  } catch {}
  return val;
}

export function parseXmlParameters(body) {
  if (!body || typeof body !== 'string') return {};
  const trimmed = body.trim();
  if (!trimmed) return {};

  // Try JSON first (e.g. body is {"path": "..."})
  const jsonParsed = repairJsonBuffer(trimmed);
  if (jsonParsed && typeof jsonParsed === 'object' && !Array.isArray(jsonParsed) && !jsonParsed.raw_arguments) {
    if (jsonParsed.name && (jsonParsed.input || jsonParsed.arguments || jsonParsed.parameters)) {
      return jsonParsed.input ?? jsonParsed.arguments ?? jsonParsed.parameters;
    }
    return jsonParsed;
  }

  const args = {};

  // 1. AntML parameter format: <parameter name="key">value</parameter> or <param name="key">value</param>
  const namedParamRegex = /<(?:parameter|param)\s+(?:name|key)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:parameter|param)>/gi;
  let pMatch;
  while ((pMatch = namedParamRegex.exec(body)) !== null) {
    const key = pMatch[1].trim();
    const val = pMatch[2]?.trim() ?? '';
    args[key] = coerceParamValue(val);
  }

  // 2. Direct tag format: <key>value</key> (e.g. <file_path>...</file_path>, <command>...</command>)
  const directTagRegex = /<([a-zA-Z0-9_.-]+)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let dMatch;
  while ((dMatch = directTagRegex.exec(body)) !== null) {
    const tag = dMatch[1].trim();
    if (tag.toLowerCase() === 'parameter' || tag.toLowerCase() === 'param') continue;
    if (args[tag] === undefined) {
      args[tag] = coerceParamValue(dMatch[2]?.trim() ?? '');
    }
  }

  return args;
}

export function extractTextToolCalls(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  // SAFETY-02: Loại bỏ khối reasoning / thinking trước khi quét tool call.
  // 2026-10-28 (P2): phủ thêm biến thể <think> (DeepSeek-style) và khối
  // <thinking> CHƯA ĐÓNG (reasoning bị cắt giữa stream — rất phổ biến);
  // trước đây cả hai đều leak tool call trong reasoning ra thực thi.
  text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/<(?:thinking|think)>(?:(?!<\/(?:thinking|think)>)[\s\S])*$/i, '');
  if (!text.trim()) return null;

  const calls = [];

  // 1. XML-ish formats. Canonical: <tool_use name="..." id="...">{json}</tool_use>.
  //    Model-drift fallback: <tool_call> (GLM style). Bodies may also be
  //    self-describing: {"name": "X", "input": {...}} without a name attribute —
  //    unwrap them, otherwise the whole body becomes the tool input.
  if (/<tool_use|<tool_call/i.test(text)) {
    const xmlRegex = /<(tool_use|tool_call)\b(?:\s+name=["']([^"']+)["'])?(?:\s+id=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = xmlRegex.exec(text)) !== null) {
      const tag = match[1].toLowerCase();
      const rawName = match[2];
      const rawId = match[3];
      const rawBody = match[4]?.trim() || '{}';
      let parsedArgs = repairJsonBuffer(rawBody);
      if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs) || Object.keys(parsedArgs).length === 0) {
        const xmlArgs = parseXmlParameters(rawBody);
        if (Object.keys(xmlArgs).length > 0) {
          parsedArgs = xmlArgs;
        }
      }
      const selfDescribing =
        parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs) &&
        typeof parsedArgs.name === 'string' &&
        (parsedArgs.input !== undefined || parsedArgs.arguments !== undefined || parsedArgs.parameters !== undefined);
      const name = rawName || (selfDescribing ? parsedArgs.name : undefined) || parsedArgs?.name;
      if (name && name !== 'unknown_tool') {
        const args = selfDescribing ? (parsedArgs.input ?? parsedArgs.arguments ?? parsedArgs.parameters) : (typeof parsedArgs === 'object' ? parsedArgs : { raw: rawBody });
        calls.push({
          id: rawId || `call_${randomUUID().replaceAll('-', '').slice(0, 9)}`,
          name,
          arguments: typeof args === 'object' && !Array.isArray(args) ? args : { raw: rawBody }
        });
      }
    }
  }

  // 1b. Bare antml-style <invoke name="..."> blocks with XML-ish parameter children.
  if (!calls.length && /<invoke\s/i.test(text)) {
    const invokeRegex = /<invoke\s+name=["']([^"']+)["'](?:\s+id=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/invoke>/gi;
    let match;
    while ((match = invokeRegex.exec(text)) !== null) {
      const rawName = match[1]?.trim() || '';
      const rawId = match[2];
      const body = match[3] || '';
      const args = parseXmlParameters(body);
      calls.push({
        id: rawId || `call_${randomUUID().replaceAll('-', '').slice(0, 9)}`,
        name: rawName,
        arguments: args
      });
    }
  }

  // 1c. Bracket syntax: [Tool Call: ToolName({...})] or [Function Call: ...], single or multiple
  if (!calls.length && /\[(?:Tool|Function)?\s*Call:\s*/i.test(text)) {
    const bMatch = text.match(/\[(?:Tool|Function)?\s*Call:\s*[\s\S]*/i);
    if (bMatch) {
      const bracketContent = bMatch[0];
      const callRegex = /([a-zA-Z0-9_\-\.]+)\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
      let m;
      while ((m = callRegex.exec(bracketContent)) !== null) {
        const rawName = m[1].trim();
        const rawArgs = m[2].trim();
        // Normalize unescaped Windows paths: e.g. "C:\Users\..." -> "C:/Users/..." (ensure only actual drive letters like "C:\)
        const normalizedPaths = rawArgs.replace(/(["'\s=])([A-Za-z]:\\[^"'\r\n,}]+)/g, (match, prefix, drivePath) => {
          return `${prefix}${drivePath.replace(/\\/g, '/')}`;
        });
        let parsedArgs = null;
        try {
          parsedArgs = JSON.parse(normalizedPaths);
        } catch {
          try {
            parsedArgs = JSON.parse(rawArgs);
          } catch {
            const fixedBackslashes = normalizedPaths.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\');
            try {
              parsedArgs = JSON.parse(fixedBackslashes);
            } catch {
              const repaired = repairJsonBuffer(fixedBackslashes);
              if (repaired && typeof repaired === 'object' && !repaired.raw_arguments) {
                parsedArgs = repaired;
              }
            }
          }
        }
        if (parsedArgs && typeof parsedArgs === 'object') {
          for (const key of ['file_path', 'path', 'filePath', 'AbsolutePath', 'target_file', 'dir', 'cwd']) {
            if (typeof parsedArgs[key] === 'string' && /^[A-Za-z]:/i.test(parsedArgs[key])) {
              parsedArgs[key] = parsedArgs[key].replace(/[\r\n]+/g, '').replace(/\\/g, '/');
            }
          }
        }
        if (!parsedArgs || typeof parsedArgs !== 'object') {
          const argsObj = {};
          const fpMatch = rawArgs.match(/"(file_path|path|filePath|target_file|AbsolutePath)"\s*:\s*"([^"]+)"/);
          if (fpMatch) {
            argsObj[fpMatch[1]] = fpMatch[2].replace(/\\/g, '/');
          }
          const contentMatch = rawArgs.match(/"(content|CodeContent|file_text)"\s*:\s*"([\s\S]*)"\s*\}?$/);
          if (contentMatch) {
            argsObj[contentMatch[1]] = contentMatch[2]
              .replace(/\\n/g, '\n')
              .replace(/\\r/g, '\r')
              .replace(/\\t/g, '\t')
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, '\\');
          }
          const cmdMatch = rawArgs.match(/"(command|CommandLine|cmd|script)"\s*:\s*"([\s\S]*)"\s*\}?$/);
          if (cmdMatch) {
            argsObj[cmdMatch[1]] = cmdMatch[2];
          }
          parsedArgs = Object.keys(argsObj).length ? argsObj : { raw: rawArgs };
        }
        calls.push({
          id: `call_${randomUUID().replaceAll('-', '').slice(0, 9)}`,
          name: rawName,
          arguments: parsedArgs
        });
      }
    }
  }

  // 2. Check for DSML format: <| DSML | tool_calls> ... <| DSML | invoke name="..."> ... </| DSML | invoke> </| DSML | tool_calls>
  if (!calls.length && text.includes('DSML')) {
    const invokeRegex = /<\|\s*DSML\s*\|\s*invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/\|\s*DSML\s*\|\s*invoke>/gi;
    let match;
    while ((match = invokeRegex.exec(text)) !== null) {
      const rawName = match[1];
      const body = match[2] || '';
      const args = {};

      const paramRegex = /<\|\s*DSML\s*\|\s*parameter\s+name=["']([^"']+)["'](?:\s+type=["']([^"']+)["'])?(?:\s+string=["']([^"']+)["'])?\s*>([\s\S]*?)<\/\|\s*DSML\s*\|\s*parameter>/gi;
      let pMatch;
      while ((pMatch = paramRegex.exec(body)) !== null) {
        const paramName = pMatch[1];
        const isStringAttr = pMatch[3];
        const rawVal = pMatch[4]?.trim() || '';

        let val = rawVal;
        if (isStringAttr === 'false') {
          if (rawVal === 'true') val = true;
          else if (rawVal === 'false') val = false;
          else if (!isNaN(Number(rawVal)) && rawVal !== '') val = Number(rawVal);
        }
        args[paramName] = val;
      }

      calls.push({
        id: `call_${randomUUID().replaceAll('-', '').slice(0, 9)}`,
        name: rawName,
        arguments: args
      });
    }
  }

  // 3. Check for code fence with proxy_tool_calls: ```json {"type":"proxy_tool_calls","calls":[...]} ```
  if (!calls.length && text.includes('proxy_tool_calls')) {
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?"proxy_tool_calls"[\s\S]*?\})\s*```/i);
    if (jsonMatch) {
      const parsed = repairJsonBuffer(jsonMatch[1]);
      if (parsed?.type === 'proxy_tool_calls' && Array.isArray(parsed.calls)) {
        for (const c of parsed.calls) {
          if (c && typeof c === 'object' && c.name) {
            calls.push({
              id: c.id || `call_${randomUUID().replaceAll('-', '').slice(0, 9)}`,
              name: c.name,
              arguments: c.input || c.arguments || {}
            });
          }
        }
      }
    }
  }

  // 4. Cline format: <execute_command>command</execute_command> or <read_file><path>...</path></read_file>
  if (!calls.length && /<(?:execute_command|read_file|write_file|apply_diff|list_files|search_files|shell|run_shell)\b/i.test(text)) {
    const clineRegex = /<(execute_command|read_file|write_file|apply_diff|list_files|search_files|shell|run_shell)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = clineRegex.exec(text)) !== null) {
      const tag = match[1].toLowerCase();
      const body = match[2]?.trim() || '';
      const args = {};
      // Parse nested <key>value</key> params
      const paramRegex = /<([a-zA-Z0-9_.-]+)>([\s\S]*?)<\/\1>/g;
      let pMatch;
      while ((pMatch = paramRegex.exec(body)) !== null) {
        const key = pMatch[1];
        const val = pMatch[2]?.trim() || '';
        if (val === 'true') args[key] = true;
        else if (val === 'false') args[key] = false;
        else if (/^-?\d+(\.\d+)?$/.test(val)) args[key] = Number(val);
        else { try { args[key] = JSON.parse(val); } catch { args[key] = val; } }
      }
      // Nếu không có nested params, body là giá trị duy nhất
      if (!Object.keys(args).length && body) {
        if (tag === 'execute_command' || tag === 'shell' || tag === 'run_shell') args.command = body;
        else if (tag === 'read_file') args.file_path = body;
        else if (tag === 'write_file') args.content = body;
        else if (tag === 'search_files' || tag === 'list_files') args.path = body;
        else args.input = body;
      }
      // Ánh xạ tag → ideal name
      const tagToName = { execute_command: 'executeShellCommand', read_file: 'readFile', write_file: 'createFile', apply_diff: 'editFile', list_files: 'listDirectory', search_files: 'searchInFiles', shell: 'executeShellCommand', run_shell: 'executeShellCommand' };
      calls.push({
        id: `call_${randomUUID().replaceAll('-', '').slice(0, 9)}`,
        name: tagToName[tag] || tag,
        arguments: args
      });
    }
  }

  // 5. Aider /edit format: >>>>>>> ORIGINAL ... ======= ... <<<<<<< UPDATED
  if (!calls.length && />>>>>>>\s*ORIGINAL[\s\S]*?=======[\s\S]*?<<<<<<<\s*UPDATED/i.test(text)) {
    const aiderRegex = /([\w./\\-]+)\n>>>>>>>\s*ORIGINAL\n([\s\S]*?)=======\n([\s\S]*?)<<<<<<<\s*UPDATED/g;
    let match;
    while ((match = aiderRegex.exec(text)) !== null) {
      calls.push({
        id: `call_${randomUUID().replaceAll('-', '').slice(0, 9)}`,
        name: 'editFile',
        arguments: { file_path: match[1].trim(), old_string: match[2], new_string: match[3] }
      });
    }
  }

  // 6. Generic JSON tool_calls array (không fence, bare JSON)
  if (!calls.length && /\{\s*"type"\s*:\s*"tool_calls"/.test(text)) {
    try {
      const jsonMatch = text.match(/\{[\s\S]*"type"\s*:\s*"tool_calls"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = repairJsonBuffer(jsonMatch[0]);
        if (parsed?.type === 'tool_calls' && Array.isArray(parsed.calls)) {
          for (const c of parsed.calls) {
            if (c && typeof c === 'object' && c.name) {
              calls.push({
                id: c.id || `call_${randomUUID().replaceAll('-', '').slice(0, 9)}`,
                name: c.name,
                arguments: c.input || c.arguments || {}
              });
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 6b. Standard OpenAI tool_calls format: {"tool_calls": [{"name": "...", "arguments": {...}}]} or {"tool_calls": [{"function": {...}}]}
  if (!calls.length && /"tool_calls"\s*:\s*\[/.test(text)) {
    try {
      const jsonMatch = text.match(/\{[\s\S]*?"tool_calls"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = repairJsonBuffer(jsonMatch[0]);
        const list = parsed?.tool_calls;
        if (Array.isArray(list)) {
          for (const c of list) {
            const toolObj = c?.function || c;
            if (toolObj && typeof toolObj === 'object' && toolObj.name) {
              let args = toolObj.arguments || toolObj.input || toolObj.parameters || {};
              if (typeof args === 'string') {
                try { args = JSON.parse(args); } catch { args = { raw: args }; }
              }
              calls.push({
                id: c.id || `call_${randomUUID().replaceAll('-', '').slice(0, 9)}`,
                name: toolObj.name,
                arguments: typeof args === 'object' && !Array.isArray(args) ? args : { raw: args }
              });
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  // 7. OpenAI function_call style: "function_call": {"name": "...", "arguments": "..."}
  if (!calls.length && /"function_call"\s*:\s*\{/.test(text)) {
    try {
      const fcRegex = /"function_call"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let match;
      while ((match = fcRegex.exec(text)) !== null) {
        const name = match[1];
        let args = {};
        try { args = JSON.parse(match[2]); } catch { args = { raw: match[2] }; }
        calls.push({
          id: `call_${randomUUID().replaceAll('-', '').slice(0, 9)}`,
          name,
          arguments: args
        });
      }
    } catch { /* ignore */ }
  }

  // 8. Bare JSON tool call(s): {"name": "Bash", "arguments": {...}} or multiple concatenated {"name":...}{"name":...}
  if (!calls.length && /"name"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|input|parameters)"\s*:\s*\{|"(?:arguments|input|parameters)"\s*:\s*\{[\s\S]*?"name"\s*:\s*"[^"]+"/.test(text)) {    try {
      const bareRegex = /\{[^{}]*?"name"[^{}]*?"(?:arguments|input|parameters)"[\s\S]*?\}(?:\s*\})|\{[^{}]*?"(?:arguments|input|parameters)"[^{}]*?"name"[\s\S]*?\}(?:\s*\})/g;
      const matches = text.match(bareRegex);
      if (matches && matches.length) {
        // SAFETY 2026-10-28 (P1): bare-JSON chỉ được coi là tool call khi JSON
        // CHIẾMƯỚU 70% nội dung reply (sau khi bỏ whitespace). JSON nhúng giữa
        // câu giải thích / ví dụ minh họa ("To call the API you write {...}") là văn
        // xuôi, không được thực thi. Format A-D/antml có marker protocol riêng nên
        // không chịu rule này (prose + call ở cuối là luồng chính danh).
        const totalNonWs = text.replace(/\s/g, '').length;
        const matchedNonWs = matches.join('').replace(/\s/g, '').length;
        if (totalNonWs > 0 && matchedNonWs / totalNonWs < 0.7) {
          return calls.length ? calls : null;
        }
        for (const block of matches) {
          const extracted = parseBareJsonToolBlock(block);
          if (extracted && extracted.name) {
            calls.push({
              id: extracted.id || `call_${randomUUID().replaceAll('-', '').slice(0, 9)}`,
              name: extracted.name,
              arguments: extracted.arguments || {}
            });
          }
        }
      }
    } catch { /* ignore */ }
  }

  return calls.length ? calls : null;
}

export function parseBareJsonToolBlock(rawBlock) {
  if (!rawBlock || typeof rawBlock !== 'string') return null;
  const parsed = repairJsonBuffer(rawBlock);
  if (parsed && typeof parsed === 'object' && !parsed.raw_arguments && parsed.name && (parsed.arguments !== undefined || parsed.input !== undefined || parsed.parameters !== undefined)) {
    const args = parsed.arguments ?? parsed.input ?? parsed.parameters ?? {};
    return {
      id: parsed.id,
      name: parsed.name,
      arguments: typeof args === 'object' && !Array.isArray(args) ? args : { raw: args }
    };
  }

  // Tolerant regex fallback when unescaped quotes or malformed JSON break standard parsing
  const nameMatch = rawBlock.match(/"name"\s*:\s*"([^"]+)"/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const idMatch = rawBlock.match(/"id"\s*:\s*"([^"]+)"/);
  const id = idMatch ? idMatch[1] : undefined;

  const argsMatch = rawBlock.match(/"(?:arguments|input|parameters)"\s*:\s*\{([\s\S]*)\}\s*\}?$/);
  if (!argsMatch) return { id, name, arguments: {} };

  const inner = argsMatch[1].replace(/\}\s*$/, '').trim();
  const innerParsed = repairJsonBuffer(`{${inner}}`);
  if (innerParsed && typeof innerParsed === 'object' && !innerParsed.raw_arguments) {
    return { id, name, arguments: innerParsed };
  }

  const args = {};
  const cmdMatch = inner.match(/"(command|CommandLine|cmd|script|path|filePath|file_path|AbsolutePath|content|CodeContent)"\s*:\s*"([\s\S]*)"\s*$/);
  if (cmdMatch) {
    args[cmdMatch[1]] = cmdMatch[2];
  } else {
    const pairRegex = /"([^"]+)"\s*:\s*"([\s\S]*?)"(?:\s*,|\s*$)/g;
    let pm;
    while ((pm = pairRegex.exec(inner)) !== null) {
      args[pm[1]] = pm[2];
    }
  }
  return { id, name, arguments: Object.keys(args).length ? args : { raw: inner } };
}
