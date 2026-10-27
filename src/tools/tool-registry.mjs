/**
 * Universal Tool Registry (Nâng cấp 1)
 * Đăng ký và ánh xạ tool xuyên IDE: Claude Code, Cursor, Windsurf, Continue, Cline, Aider.
 * Thay thế hardcoded SHELL_TOOLS Set và normalizeKey alias map bằng registry động.
 */

import { createHash } from 'node:crypto';

// ─── IDE Tool Maps: idealName → IDE-specific tool name ───
export const IDE_TOOL_MAPS = {
  'claude-code': {
    executeShellCommand: 'Bash',
    readFile: 'Read',
    createFile: 'Write',
    editFile: 'Edit',
    listDirectory: 'Bash',      // qua lệnh ls
    searchInFiles: 'Bash',      // qua lệnh rg
    fetchUrl: 'WebFetch',
    webSearch: 'WebSearch',
  },
  'cursor': {
    executeShellCommand: 'run_command',
    readFile: 'view_file',
    createFile: 'write_to_file',
    editFile: 'replace_file_content',
    listDirectory: 'list_dir',
    searchInFiles: 'grep_search',
    fetchUrl: 'fetch_url',
    webSearch: 'web_search',
  },
  'windsurf': {
    executeShellCommand: 'execute_command',
    readFile: 'read_file',
    createFile: 'create_file',
    editFile: 'edit_file',
    listDirectory: 'list_directory',
    searchInFiles: 'search_files',
    fetchUrl: 'read_url_content',
    webSearch: 'search_web',
  },
  'continue': {
    executeShellCommand: 'shell',
    readFile: 'read_file',
    createFile: 'write_file',
    editFile: 'edit_file',
    listDirectory: 'list_directory',
    searchInFiles: 'search_in_files',
    fetchUrl: 'fetch_url',
    webSearch: 'web_search',
  },
  'cline': {
    executeShellCommand: 'execute_command',
    readFile: 'read_file',
    createFile: 'write_to_file',
    editFile: 'apply_diff',
    listDirectory: 'list_files',
    searchInFiles: 'search_files',
    fetchUrl: 'fetch_url',
    webSearch: 'search_web',
  },
  'antigravity': {
    executeShellCommand: 'terminal',
    readFile: 'read_file',
    createFile: 'write_file',
    editFile: 'edit_file',
    listDirectory: 'list_dir',
    searchInFiles: 'search_files',
    fetchUrl: 'fetch_url',
    webSearch: 'web_search',
  },
  'zcode': {
    executeShellCommand: 'executeShellCommand',
    readFile: 'readFile',
    createFile: 'createFile',
    editFile: 'editFile',
    listDirectory: 'listDirectory',
    searchInFiles: 'searchInFiles',
    fetchUrl: 'fetchUrl',
    webSearch: 'webSearch',
  },
  'roo-code': {
    executeShellCommand: 'execute_command',
    readFile: 'read_file',
    createFile: 'write_to_file',
    editFile: 'apply_diff',
    listDirectory: 'list_files',
    searchInFiles: 'search_files',
    fetchUrl: 'fetch_url',
    webSearch: 'search_web',
  },
  'pentagi': {
    executeShellCommand: 'terminal',
    readFile: 'read_file',
    createFile: 'write_file',
    editFile: 'edit_file',
    listDirectory: 'list_dir',
    searchInFiles: 'search_files',
    fetchUrl: 'fetch_url',
    webSearch: 'web_search',
  },
  'aider': {
    executeShellCommand: 'run_shell',
    readFile: 'read_file',
    createFile: 'write_file',
    editFile: 'apply_edit',
    listDirectory: 'list_directory',
    searchInFiles: 'grep_search',
    fetchUrl: 'web_fetch',
    webSearch: 'web_search',
  },
};

// ─── Normalize key cho so khớp tên tool lỏng lẻo ───
export const normalizeKey = (key) => (typeof key === 'string' ? key.toLowerCase().replace(/[^a-z0-9]/g, '') : '');

// ─── Bảng alias 2 chiều: tên gọi khác → idealName ───
const ALIAS_MAP = {
  // Shell/Execute
  executeshellcommand: 'executeShellCommand',
  executeshell: 'executeShellCommand',
  bash: 'executeShellCommand',
  exec: 'executeShellCommand',
  shellcommand: 'executeShellCommand',
  shell: 'executeShellCommand',
  runcommand: 'executeShellCommand',
  executecommand: 'executeShellCommand',
  terminal: 'executeShellCommand',
  runterminal: 'executeShellCommand',
  // Directory listing
  listdirectory: 'listDirectory',
  listdir: 'listDirectory',
  ls: 'listDirectory',
  dir: 'listDirectory',
  listfiles: 'listDirectory',
  // Search
  searchfiles: 'searchInFiles',
  searchinfiles: 'searchInFiles',
  grepsearch: 'searchInFiles',
  grep: 'searchInFiles',
  findinfiles: 'searchInFiles',
  rg: 'searchInFiles',
  // Read
  readfile: 'readFile',
  read: 'readFile',
  cat: 'readFile',
  viewfile: 'readFile',
  // Write/Create
  createfile: 'createFile',
  writefile: 'createFile',
  write: 'createFile',
  writetofile: 'createFile',
  // Edit
  editfile: 'editFile',
  edit: 'editFile',
  replace: 'editFile',
  replacefilecontent: 'editFile',
  applydiff: 'editFile',
  applyedit: 'editFile',
  // Fetch
  fetchurl: 'fetchUrl',
  webfetch: 'fetchUrl',
  fetch: 'fetchUrl',
  readurlcontent: 'fetchUrl',
  // Search web
  websearch: 'webSearch',
  search: 'webSearch',
  searchweb: 'webSearch',
};

/**
 * Giải idealName từ bất kỳ alias nào.
 */
export function resolveIdealName(rawName) {
  const norm = normalizeKey(rawName);
  return ALIAS_MAP[norm] || rawName;
}

/**
 * Tìm tool phù hợp nhất trong catalog cho idealName, ưu tiên IDE cụ thể.
 * @param {string} idealName - Tên tool chuẩn (executeShellCommand, readFile, ...)
 * @param {Array} availableTools - Catalog tool từ client (có .name)
 * @param {string} ideType - Loại IDE ('claude-code', 'cursor', ...)
 * @returns {{ name: string, definition: object }|null}
 */
export function resolveTool(idealName, availableTools, ideType = 'claude-code') {
  if (!Array.isArray(availableTools) || !availableTools.length) return null;
  const getToolName = (t) => t?.name || t?.function?.name || '';

  // 1. Ưu tiên khớp chính xác tên tool có sẵn trong client catalog
  const exact = availableTools.find((t) => getToolName(t) === idealName);
  if (exact) return { name: getToolName(exact), definition: exact };

  // 1b. Khớp normalizeKey trực tiếp
  const normIdeal = normalizeKey(idealName);
  const normDirect = availableTools.find((t) => normalizeKey(getToolName(t)) === normIdeal);
  if (normDirect) return { name: getToolName(normDirect), definition: normDirect };

  // 2. Ưu tiên ánh xạ IDE-specific
  const ideMap = IDE_TOOL_MAPS[ideType] || IDE_TOOL_MAPS['claude-code'];
  const ideTarget = ideMap[idealName];
  if (ideTarget) {
    const found = availableTools.find((t) => getToolName(t) === ideTarget || normalizeKey(getToolName(t)) === normalizeKey(ideTarget));
    if (found) return { name: getToolName(found), definition: found };
  }

  // 3. Tìm theo tất cả IDE maps — tool name nào khớp?
  for (const [ide, map] of Object.entries(IDE_TOOL_MAPS)) {
    const mapped = map[idealName];
    if (mapped) {
      const found = availableTools.find((t) => getToolName(t) === mapped || normalizeKey(getToolName(t)) === normalizeKey(mapped));
      if (found) return { name: getToolName(found), definition: found };
    }
  }

  // 4. Fuzzy: tìm tool có normalizeKey khớp alias
  for (const [alias, ideal] of Object.entries(ALIAS_MAP)) {
    if (ideal === idealName || alias === normIdeal) {
      const found = availableTools.find((t) => normalizeKey(getToolName(t)) === alias || normalizeKey(getToolName(t)) === normalizeKey(ideal));
      if (found) return { name: getToolName(found), definition: found };
    }
  }

  return null;
}

/**
 * Đăng ký template IDE mới (merge vào IDE_TOOL_MAPS).
 * @param {string} ideType
 * @param {object} toolMap - { idealName: ideSpecificName }
 */
export function registerIDETemplate(ideType, toolMap) {
  if (!ideType || typeof toolMap !== 'object') return;
  IDE_TOOL_MAPS[ideType] = { ...IDE_TOOL_MAPS[ideType], ...toolMap };
}

/**
 * Liệt kê tất cả ideal names đã biết.
 */
export function knownIdealNames() {
  return [...new Set(Object.values(ALIAS_MAP))];
}

/**
 * Kiểm tra tool name có phải shell tool không (cần sandbox/permission).
 */
const SHELL_IDEALS = new Set(['executeShellCommand']);
export function isShellTool(name) {
  return SHELL_IDEALS.has(resolveIdealName(name));
}

/**
 * ToolRegistry class — bao bọc tất cả chức năng registry.
 */
export class ToolRegistry {
  constructor() {
    this._ideType = 'claude-code';
    this._tools = [];
    this._customMaps = {};
  }

  setIDE(ideType) { this._ideType = ideType; return this; }
  setCatalog(tools) { this._tools = tools; return this; }
  registerTemplate(ideType, map) { registerIDETemplate(ideType, map); return this; }

  resolve(idealName) {
    return resolveTool(idealName, this._tools, this._ideType);
  }

  has(idealName) {
    return this.resolve(idealName) !== null;
  }

  get ideType() { return this._ideType; }
  get knownTools() { return knownIdealNames(); }
}
