// src/clickup-tools.mjs
// Module xử lý Toolcall & MCP thích ứng cho ClickUp Upstream trong SharkPool
// Bao gồm: Universal Tool Registry mapping, Parameter Healing, IDE Prompt Card, và Idle-Promise Auto-Recovery.
import { resolveTool, normalizeKey } from '../../tools/tool-registry.mjs';
import { getIDEAdaptations } from '../../ide-detect.mjs';
/**
 * Chuẩn hoá và chuyển đổi tên tham số (Parameter Healing) theo schema đích của công cụ
 */
export function healToolParameters(targetToolName, inputArgs, clientTools = []) {
  if (!inputArgs || typeof inputArgs !== 'object' || Array.isArray(inputArgs)) {
    return inputArgs;
  }
  const healed = { ...inputArgs };
  const targetDef = clientTools.find(
    (t) => (t.function?.name || t.name) === targetToolName || normalizeKey(t.function?.name || t.name) === normalizeKey(targetToolName)
  );
  const props = targetDef?.function?.parameters?.properties || targetDef?.parameters?.properties || targetDef?.input_schema?.properties || {};
  const propKeys = Object.keys(props);
  // 1. Healing cho Shell Command: command <-> CommandLine <-> cmd <-> script <-> raw
  const rawShell = healed.raw && typeof healed.raw === 'string' ? healed.raw.trim() : null;
  if (!healed.command && !healed.CommandLine && !healed.cmd && !healed.script && rawShell) {
    healed.command = rawShell;
  }
  if (propKeys.includes('CommandLine') && !healed.CommandLine && (healed.command || healed.cmd || healed.script)) {
    healed.CommandLine = healed.command || healed.cmd || healed.script;
  } else if (propKeys.includes('command') && !healed.command && (healed.CommandLine || healed.cmd || healed.script)) {
    healed.command = healed.CommandLine || healed.cmd || healed.script;
  } else if (propKeys.includes('cmd') && !healed.cmd && (healed.command || healed.CommandLine)) {
    healed.cmd = healed.command || healed.CommandLine;
  }
  // 2. Healing cho File Path: filePath <-> AbsolutePath <-> path <-> file_path <-> target_file
  const hasPathSource = healed.filePath || healed.AbsolutePath || healed.path || healed.file_path || healed.target_file || healed.file;
  if (hasPathSource) {
    const pathVal = hasPathSource;
    if (propKeys.includes('AbsolutePath') && !healed.AbsolutePath) {
      healed.AbsolutePath = pathVal;
    } else if (propKeys.includes('filePath') && !healed.filePath) {
      healed.filePath = pathVal;
    } else if (propKeys.includes('file_path') && !healed.file_path) {
      healed.file_path = pathVal;
    } else if (propKeys.includes('path') && !healed.path) {
      healed.path = pathVal;
    } else if (propKeys.includes('target_file') && !healed.target_file) {
      healed.target_file = pathVal;
    }
  }
  // 3. Healing cho File Content: content <-> CodeContent <-> file_text
  const hasContentSource = healed.content !== undefined ? healed.content : (healed.CodeContent !== undefined ? healed.CodeContent : healed.file_text);
  if (hasContentSource !== undefined) {
    if (propKeys.includes('CodeContent') && healed.CodeContent === undefined) {
      healed.CodeContent = hasContentSource;
    } else if (propKeys.includes('content') && healed.content === undefined) {
      healed.content = hasContentSource;
    }
  }
  // 4. Healing cho File Edit: old_string/new_string <-> TargetContent/ReplacementContent <-> old_text/new_text
  const oldText = healed.old_string ?? healed.TargetContent ?? healed.old_text ?? healed.target_string;
  const newText = healed.new_string ?? healed.ReplacementContent ?? healed.new_text ?? healed.replacement_string;
  if (oldText !== undefined) {
    if (propKeys.includes('TargetContent') && healed.TargetContent === undefined) healed.TargetContent = oldText;
    if (propKeys.includes('old_string') && healed.old_string === undefined) healed.old_string = oldText;
  }
  if (newText !== undefined) {
    if (propKeys.includes('ReplacementContent') && healed.ReplacementContent === undefined) healed.ReplacementContent = newText;
    if (propKeys.includes('new_string') && healed.new_string === undefined) healed.new_string = newText;
  }
  // 5. Healing cho Directory: DirectoryPath <-> path <-> dir <-> directory
  const hasDirSource = healed.DirectoryPath || healed.path || healed.dir || healed.directory;
  if (hasDirSource) {
    if (propKeys.includes('DirectoryPath') && !healed.DirectoryPath) healed.DirectoryPath = hasDirSource;
    else if (propKeys.includes('path') && !healed.path) healed.path = hasDirSource;
  }
  // 6. Healing cho URL: url <-> Url <-> uri <-> link <-> target_url <-> address
  const hasUrlSource = healed.url || healed.Url || healed.link || healed.uri || healed.target_url || healed.address;
  if (hasUrlSource) {
    const urlVal = hasUrlSource;
    if (propKeys.includes('url') && !healed.url) healed.url = urlVal;
    if (propKeys.includes('Url') && !healed.Url) healed.Url = urlVal;
    if (propKeys.includes('uri') && !healed.uri) healed.uri = urlVal;
    if (propKeys.includes('link') && !healed.link) healed.link = urlVal;
  } else if (propKeys.includes('url') || propKeys.includes('Url')) {
    const urlInRaw = typeof healed.raw === 'string' ? healed.raw.match(/https?:\/\/[^\s"'<>)]+/i) : null;
    if (urlInRaw) {
      if (propKeys.includes('url') && !healed.url) healed.url = urlInRaw[0];
      if (propKeys.includes('Url') && !healed.Url) healed.Url = urlInRaw[0];
    }
  }
  // 7. Healing cho prompt/query trong Web / Search tools (tránh lỗi thiếu prompt của WebFetch)
  // CHỈ tự điền khi tham số là REQUIRED trong schema (khi đó tool không thể chạy nếu thiếu —
  // prompt trung tính là mặc định chức năng) hoặc khi đã có nguồn nội dung từ model.
  // Không bao giờ bịa giá trị cho tham số optional mà model không sinh ra.
  const isWebTool = targetToolName.toLowerCase().includes('fetch') || targetToolName.toLowerCase().includes('web') || targetToolName.toLowerCase().includes('search');
  if (isWebTool) {
    const webSchema = targetDef?.function?.parameters || targetDef?.parameters || targetDef?.input_schema || {};
    const webRequired = Array.isArray(webSchema.required) ? webSchema.required : [];
    const hasPromptSource = Boolean(healed.query || healed.instruction || healed.description);
    const hasQuerySource = Boolean(healed.prompt || healed.instruction || healed.description || healed.url);
    if (propKeys.includes('prompt') && !healed.prompt && (webRequired.includes('prompt') || hasPromptSource)) {
      healed.prompt = healed.query || healed.instruction || healed.description || 'Extract all content, files, links, and structure from this URL';
    }
    if (propKeys.includes('query') && !healed.query && (webRequired.includes('query') || hasQuerySource)) {
      healed.query = healed.prompt || healed.instruction || healed.description || (healed.url ? `Content from ${healed.url}` : '');
    }
  }
  return healed;
}
/**
 * Factory tạo Tool Mapper theo IDE và danh sách tools từ client
 */
export function createClickUpToolMapper(ideType = 'unknown', tools = [], cwd = '') {
  const adaptations = getIDEAdaptations(ideType);
  return {
    ideType,
    adaptations,
    tools,
    cwd,
    map(call) {
      if (!call) return null;
      let rawName = call.name || call.function?.name;
      if (!rawName) return null;
      // Loại bỏ prefix nếu model tự ý sinh codex_mcp_server__ hoặc mcp__
      rawName = rawName.replace(/^(?:codex_mcp_server__|mcp__)/i, '');
      try {
        const resolved = resolveTool(rawName, tools, ideType);
        // SAFETY 2026-10-28: tool call chỉ được phát khi tên resolve được tới MỘT tool
        // có thật trong catalog client (exact/normalize/IDE-map/fuzzy alias).
        // Không còn fallback `|| resolveIdealName(rawName) || rawName` — trước đây
        // 'definitelyNotATool' hoặc ví dụ JSON trong văn xuôi đều được phát ra client.
        if (!resolved) {
          console.warn(`[ClickUpTools] Bo qua tool call "${rawName}" vi khong ton tai trong tool catalog cua client`);
          return null;
        }
        const targetName = resolved.name;
        let parsedArgs = call.arguments ?? call.function?.arguments ?? call.input ?? {};
        if (typeof parsedArgs === 'string') {
          try {
            parsedArgs = JSON.parse(parsedArgs);
          } catch {
            parsedArgs = { raw: parsedArgs };
          }
        }
        const healedArgs = healToolParameters(targetName, parsedArgs, tools);
        // Validation an toàn: Generic Required Parameter Guard
        const targetDef = tools.find(
          (t) => (t.function?.name || t.name) === targetName || normalizeKey(t.function?.name || t.name) === normalizeKey(targetName)
        );
        const paramSchema = targetDef?.function?.parameters || targetDef?.parameters || targetDef?.input_schema || {};
        const requiredProps = Array.isArray(paramSchema.required) ? paramSchema.required : [];
        // 1. Kiểm tra theo danh sách required properties trong schema nếu có
        if (requiredProps.length > 0) {
          const missing = requiredProps.filter((reqProp) => {
            const val = healedArgs ? healedArgs[reqProp] : undefined;
            return val === undefined || val === null || val === '';
          });
          if (missing.length > 0) {
            console.warn(`[ClickUpTools] Bo qua tool call "${targetName}" vi thieu tham so bat buoc: ${missing.join(', ')}`);
            return null;
          }
        }
        // 2. Fallback kiểm tra cho các tool phổ biến nếu schema không khai báo required
        const isShell = ['Bash', 'executeShellCommand', 'terminal', 'run_command'].includes(targetName);
        if (isShell && (!healedArgs || (!healedArgs.command && !healedArgs.CommandLine && !healedArgs.cmd && !healedArgs.script))) {
          console.warn(`[ClickUpTools] Bo qua tool call "${targetName}" vi khong co command hop le`);
          return null;
        }
        const isRead = ['Read', 'readFile', 'view_file'].includes(targetName);
        if (isRead && (!healedArgs || (!healedArgs.filePath && !healedArgs.path && !healedArgs.file_path && !healedArgs.AbsolutePath))) {
          console.warn(`[ClickUpTools] Bo qua tool call "${targetName}" vi khong co duong dan file hop le`);
          return null;
        }
        const isWeb = ['WebFetch', 'fetchUrl', 'read_url_content'].includes(targetName);
        if (isWeb && (!healedArgs || (!healedArgs.url && !healedArgs.Url && !healedArgs.link))) {
          console.warn(`[ClickUpTools] Bo qua tool call "${targetName}" vi khong co url hop le`);
          return null;
        }
        // 3. Không bao giờ phát tool call rỗng khi tool CẦN tham số: schema khai báo required
        // hoặc tool thuộc nhóm thực thi lõi (shell/read/web). Tool có properties nhưng tất cả
        // optional được phép gọi với {} — đó là call zero-arg hợp lệ, không phải lỗi.
        if (!healedArgs || Object.keys(healedArgs).length === 0) {
          const hasProps = Object.keys(paramSchema.properties || {}).length > 0;
          const needsParams = requiredProps.length > 0 || isShell || isRead || isWeb;
          if (hasProps && needsParams) {
            console.warn(`[ClickUpTools] Bo qua tool call "${targetName}" vi input rong hoan toan`);
            return null;
          }
        }
        return {
          id: call.id || `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'function',
          name: targetName,
          input: healedArgs,
          function: {
            name: targetName,
            arguments: typeof healedArgs === 'string' ? healedArgs : JSON.stringify(healedArgs),
          },
        };
      } catch (err) {
        console.warn(`[ClickUpTools] mapToolCall failed for "${rawName}": ${err.message}`);
        return null;
      }
    },
  };
}
/**
 * Sinh Prompt Card chuẩn định dạng cho ClickUp models
 */
export function buildClickUpToolPromptCard(tools = [], ideType = 'unknown') {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const defs = tools.map((t) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || fn.input_schema || {},
    };
  });
  let ideSpecificNotes = '';
  if (ideType === 'cline') {
    ideSpecificNotes =
      '\n[CLINE / ROO CODE ENVIRONMENT INSTRUCTION]:\n' +
      'You are interacting with Cline / Roo Code. In addition to standard JSON formats, you may use direct XML tags:\n' +
      '  <execute_command><command>...</command></execute_command>\n' +
      '  <read_file><path>...</path></read_file>\n' +
      '  <write_to_file><path>...</path><content>...</content></write_to_file>\n' +
      '  <replace_in_file><path>...</path><diff>...</diff></replace_in_file>\n';
  } else if (ideType === 'cursor') {
    ideSpecificNotes =
      '\n[CURSOR ENVIRONMENT INSTRUCTION]:\n' +
      'You are interacting with Cursor IDE. Follow Cursor execution semantics with available tools.\n';
  }
  return (
    `[Available tools] (Client: ${ideType})\n` +
    'The user is working in an IDE/agentic development environment. You have direct access to the following executable tools:\n' +
    JSON.stringify(defs, null, 2) +
    '\n\n' +
    'TOOL CALL SYNTAX:\n' +
    '   Respond using ONE of these standard formats:\n' +
    '   Format A (Standard JSON):\n' +
    '   {"tool_calls": [{"name": "<exact_tool_name>", "arguments": { <arguments> }}]}\n\n' +
    '   Format B (Tool Call XML):\n' +
    '   <tool_call>{"name": "<exact_tool_name>", "arguments": { <arguments> }}</tool_call>\n\n' +
    '   Format C (Single call JSON):\n' +
    '   {"name": "<exact_tool_name>", "arguments": { <arguments> }}\n\n' +
    '   Format D (Bracket syntax):\n' +
    '   [Tool Call: <exact_tool_name>({"arg": "val"})]\n\n' +
    '   CRITICAL SYNTAX RULE: NEVER wrap tool calls in markdown code fences (like ```json or ```). Output the tool call directly on its own line.\n' +
    ideSpecificNotes +
    '\nIf the user request is purely conversational and requires NO file or system interaction, reply with natural text.\n' +
    '[/Available tools]'
  );
}
/**
 * ĐÃ GỠ CƠ CHỈ TỰ TỔNG HỢP TOOL CALL (2026-10-27):
 * Hàm từng suy đoán file/lệnh/thư mục từ văn bản "lời hứa suông" của model rồi tự bịa tool call
 * (kể cả sinh lệnh shell kiểu type/cat/dir) — gateway không được tự chế lệnh thực thi thay
 * model và IDE client. Chống stall giờ thuộc về tầng client.
 * Giữ export dạng no-op để bảo toàn API cho bên import qua shim src/clickup-tools.mjs.
 */
export function detectAndRecoverIdlePromise(text, availableTools = []) {
  return null;
}
export const CLICKUP_TOOL_MARKER_REGEX = /(?:```(?:[a-zA-Z0-9_-]+)?\s*)?(?:<(?:tool_call|tool_use|invoke|execute_command|read_file|write_file|apply_diff)|<[|｜]+\s*DSML\s*[|｜]+\s*(?:tool_calls|calls|invoke)|\[(?:Tool|Function)?\s*Call:|```(?:json)?\s*\{?\s*"(?:proxy_tool_calls|tool_calls|name)"|\{\s*"name"\s*:\s*"(?:Bash|Read|Write|Edit|executeShellCommand|readFile|writeFile|createFile|listDirectory|searchFiles|searchInFiles|fetchUrl|webSearch|[a-zA-Z0-9_-]+)"\s*,\s*"(?:arguments|input|parameters)"|\{\s*"(?:tool_calls|name|function_call)"\s*:)/i;
/**
 * Trích xuất đoạn hội thoại trước tool call (loại bỏ hoàn toàn raw markup, code fence mở và bracket tool call)
 */
export function extractPreToolText(text) {
  if (!text || typeof text !== 'string') return '';
  const marker = text.search(CLICKUP_TOOL_MARKER_REGEX);
  let pre = marker !== -1 ? text.slice(0, marker) : text;
  // Loại bỏ hoàn toàn markdown code fence mở bị sót ở cuối chuỗi text (ví dụ: ```json hoặc ```)
  pre = pre.replace(/(?:\r?\n|^)\s*```(?:[a-zA-Z0-9_-]+)?\s*$/g, '').trim();
  if (/^```(?:[a-zA-Z0-9_-]+)?\s*$/i.test(pre)) return '';
  return pre;
}