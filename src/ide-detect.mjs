/**
 * IDE Detection (Nâng cấp 2)
 * Phát hiện IDE/client kết nối từ headers, user-agent, và tool catalog patterns.
 * Trả về cấu hình vận hành phù hợp từng IDE.
 */

// ─── IDE Profiles: transport, capabilities, conventions ───
export const IDE_PROFILES = {
  'claude-code': {
    transport: 'native',
    supportsBatch: true,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 200000,
  },
  'cursor': {
    transport: 'native',
    supportsBatch: false,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 128000,
  },
  'windsurf': {
    transport: 'mcp',
    supportsBatch: false,
    supportsMCP: true,
    resultFormat: 'openai',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: false,
    supportsImages: true,
    maxContextTokens: 128000,
  },
  'continue': {
    transport: 'mcp',
    supportsBatch: false,
    supportsMCP: true,
    resultFormat: 'openai',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: false,
    supportsImages: false,
    maxContextTokens: 100000,
  },
  'cline': {
    transport: 'mcp',
    supportsBatch: false,
    supportsMCP: false,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: false,
    supportsImages: true,
    maxContextTokens: 128000,
  },
  'aider': {
    transport: 'json',
    supportsBatch: false,
    supportsMCP: false,
    resultFormat: 'text',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: false,
    supportsThinking: false,
    supportsImages: false,
    maxContextTokens: 100000,
  },
  'zcode': {
    transport: 'mcp',
    supportsBatch: true,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 200000,
  },
  'antigravity': {
    transport: 'mcp',
    supportsBatch: true,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 200000,
  },
  'roo-code': {
    transport: 'mcp',
    supportsBatch: true,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 200000,
  },
  'gemini-cli': {
    transport: 'mcp',
    supportsBatch: true,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 200000,
  },
  'codex-cli': {
    transport: 'native',
    supportsBatch: true,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 200000,
  },
  'kiro': {
    transport: 'mcp',
    supportsBatch: true,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 200000,
  },
  'trae': {
    transport: 'mcp',
    supportsBatch: false,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 128000,
  },
  'copilot-cli': {
    transport: 'native',
    supportsBatch: false,
    supportsMCP: false,
    resultFormat: 'openai',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: false,
    supportsImages: false,
    maxContextTokens: 128000,
  },
  'opencode': {
    transport: 'mcp',
    supportsBatch: true,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 200000,
  },
  'zed': {
    transport: 'mcp',
    supportsBatch: false,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: false,
    maxContextTokens: 128000,
  },
  'amp': {
    transport: 'native',
    supportsBatch: true,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 200000,
  },
  'goose': {
    transport: 'mcp',
    supportsBatch: true,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: false,
    supportsImages: true,
    maxContextTokens: 128000,
  },
  // 2026-10-28 (P3): pentagi có UA pattern + tool map nhưng thiếu profile —
  // trước đây luôn degrade về 'unknown' (200k context + thinking mặc định quá mạnh).
  'pentagi': {
    transport: 'native',
    supportsBatch: false,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: false,
    supportsImages: false,
    maxContextTokens: 128000,
  },
  'unknown': {
    transport: 'native',
    supportsBatch: true,
    supportsMCP: true,
    resultFormat: 'anthropic',
    toolPrefix: '',
    maxToolNameLength: 64,
    supportsStreaming: true,
    supportsThinking: true,
    supportsImages: true,
    maxContextTokens: 200000,
  },
};

// ─── User-Agent patterns ───
// Toàn bộ pattern dùng word-boundary: substring trần từng bắt nhầm
// ("roo" khớp mọi chuỗi chứa "roo", "aide" khớp "aiden", "anthropic" khớp mọi SDK).
const UA_PATTERNS = [
  { pattern: /\bcursor\b/i, ide: 'cursor' },
  { pattern: /\bwindsurf\b/i, ide: 'windsurf' },
  { pattern: /continue-dev|continue\.dev|\bcontinue\b/i, ide: 'continue' },
  { pattern: /\bcline\b/i, ide: 'cline' },
  { pattern: /\broo(?:[-_ ]?(?:code|cline))?\b/i, ide: 'roo-code' },
  { pattern: /\baider\b|\bcodestory\b/i, ide: 'aider' },
  { pattern: /\bclaude[-_ ]?(?:code|cli)\b|\bclaude\s+code\b/i, ide: 'claude-code' },
  { pattern: /\bantigravity\b/i, ide: 'antigravity' },
  { pattern: /\bzcode\b/i, ide: 'zcode' },
  { pattern: /\bpentagi\b/i, ide: 'pentagi' },
  { pattern: /\bgemini[-_ ]?cli\b/i, ide: 'gemini-cli' },
  { pattern: /\b(?:openai[-_ ]?)?codex[-_ ]?(?:cli)?\b/i, ide: 'codex-cli' },
  { pattern: /\bkiro\b/i, ide: 'kiro' },
  { pattern: /\btrae\b/i, ide: 'trae' },
  { pattern: /\bcopilot[-_ ]?cli\b/i, ide: 'copilot-cli' },
  { pattern: /\bopencode\b/i, ide: 'opencode' },
  { pattern: /\bzed\b/i, ide: 'zed' },
  { pattern: /\bamp\b/i, ide: 'amp' },
  { pattern: /\bgoose\b/i, ide: 'goose' },
];
// Lưu ý: đã bỏ /\banthropic\b/ → 'claude-code'. UA chỉ có "anthropic" (mọi SDK)
// không đủ căn cứ; catalog fingerprint (Bash/Read/Write/Edit) vẫn bắt đúng Claude Code.

// ─── Tool catalog fingerprints ───
const CATALOG_FINGERPRINTS = [
  { toolNames: ['run_command', 'view_file', 'write_to_file', 'replace_file_content'], ide: 'cursor' },
  { toolNames: ['execute_command', 'read_file', 'create_file', 'edit_file'], ide: 'windsurf' },
  { toolNames: ['shell', 'read_file', 'write_file'], ide: 'continue' },
  { toolNames: ['apply_diff', 'list_files', 'search_files'], ide: 'cline' },
  { toolNames: ['Bash', 'Read', 'Write', 'Edit'], ide: 'claude-code' },
  { toolNames: ['executeShellCommand', 'readFile', 'createFile', 'editFile'], ide: 'zcode' },
  { toolNames: ['terminal', 'read_file', 'write_file', 'edit_file'], ide: 'antigravity' },
  { toolNames: ['run_shell', 'apply_edit', 'web_fetch'], ide: 'aider' },
];

/**
 * Phát hiện IDE từ request headers và tool catalog.
 * @param {object} headers - HTTP request headers
 * @param {Array} availableTools - Tool catalog từ client
 * @returns {string} ideType
 */
export function detectIDE(headers = {}, availableTools = []) {
  // 1. Explicit opt-in header
  const explicitIDE = headers['x-ide-client'] || headers['x-client-name'] || '';
  if (typeof explicitIDE === 'string' && explicitIDE.trim()) {
    const normalized = explicitIDE.trim().toLowerCase();
    if (IDE_PROFILES[normalized]) return normalized;
    // Fuzzy match: yêu cầu >=3 ký tự để header 1-2 ký tự ("z", "cu") không đoán mò IDE.
    if (normalized.length >= 3) {
      for (const ide of Object.keys(IDE_PROFILES)) {
        if (ide.includes(normalized) || normalized.includes(ide)) return ide;
      }
    }
  }

  // 2. User-Agent detection
  const ua = headers['user-agent'] || '';
  if (typeof ua === 'string') {
    for (const { pattern, ide } of UA_PATTERNS) {
      if (pattern.test(ua)) return ide;
    }
  }

  // 3. Tool catalog fingerprinting
  if (Array.isArray(availableTools) && availableTools.length > 0) {
    const toolNames = new Set(availableTools.map(t => t.name));
    let bestMatch = null;
    let bestScore = 0;
    for (const { toolNames: fingerprints, ide } of CATALOG_FINGERPRINTS) {
      const score = fingerprints.filter(name => toolNames.has(name)).length;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = ide;
      }
    }
    // Cần khớp ít nhất 2 tool để xác định
    if (bestScore >= 2 && bestMatch) return bestMatch;
  }

  // 4. Default
  return 'unknown';
}

/**
 * Lấy cấu hình vận hành cho IDE.
 * @param {string} ideType
 * @returns {object} IDE profile
 */
export function getIDEAdaptations(ideType) {
  return IDE_PROFILES[ideType] || IDE_PROFILES['unknown'];
}

/**
 * Lấy transport mode ưu tiên cho IDE.
 * @param {string} ideType
 * @returns {string} 'native' | 'mcp' | 'json'
 */
export function getPreferredTransport(ideType) {
  return getIDEAdaptations(ideType).transport;
}

/**
 * Kiểm tra IDE có hỗ trợ batch không.
 */
export function supportsBatchOps(ideType) {
  return getIDEAdaptations(ideType).supportsBatch;
}

/**
 * Kiểm tra IDE có hỗ trợ MCP không.
 */
export function supportsMCP(ideType) {
  return getIDEAdaptations(ideType).supportsMCP;
}
