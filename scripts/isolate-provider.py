from pathlib import Path

root = Path(__file__).resolve().parents[1]
p = root / 'src/clickup-pool.mjs'
s = p.read_text(encoding='utf-8')
s = s.replace("import fs from 'node:fs';\nimport path from 'node:path';", "import { readPoolConfig, persistPoolConfig } from './config.mjs';")
s = s.replace("const STATE_FILE = path.join(process.cwd(), '.state', 'clickup_config.json');", '')
a = s.index('export const DEFAULT_SPACES')
b = s.index('export function getNextDailyResetTime')
s = s[:a] + s[b:]
a = s.index('  _checkAndTriggerAutoRecreate(')
b = s.index('  getSnapshot()', a)
s = s[:a] + s[b:]
s = '\n'.join(line for line in s.split('\n') if 'this._checkAndTriggerAutoRecreate(' not in line)
a = s.index('function loadConfigFromFile()')
s = s[:a] + 'export const clickupPool = new WorkspacePool(readPoolConfig(), persistPoolConfig);\n'
a = s.index('      // Nếu tất cả workspace')
b = s.index('\n    let totalCap', a)
s = s[:a] + "      throw new Error('ClickUp quota exhausted or all workspaces are cooling down');\n    }\n" + s[b:]
s = s.replace('    await this._applyAdaptiveMicroPacing(ws, poolSaturation, signal);', '    try {\n      await this._applyAdaptiveMicroPacing(ws, poolSaturation, signal);\n    } catch (err) {\n      releaseQueue();\n      throw err;\n    }')
s = s.replace('  async _exchangeGatewayToken(ws) {', '  async _exchangeGatewayToken(ws, renewed = false) {')
s = s.replace('if (res.statusCode === 401 || res.statusCode === 403) {', 'if (!renewed && (res.statusCode === 401 || res.statusCode === 403)) {')
s = s.replace('this._exchangeGatewayToken(ws);\n                  resolve', 'this._exchangeGatewayToken(ws, true);\n                  resolve')
s = s.replace("workspaceId: '1100380000020899'", "workspaceId: ''")
s = s.replace("|| '1100380000020899'", "|| ''").replace("|| '1100380000020790'", "|| ''")
p.write_text(s, encoding='utf-8')
p = root / 'src/clickup-upstream.mjs'
s = p.read_text(encoding='utf-8')
s = s.replace('checkAntiStallStoppage, scrubPostmanIdentity', 'checkAntiStallStoppage')
s = s.replace('scrubPostmanIdentity(upstreamResult.replyText, null, actualModel)', 'upstreamResult.replyText')
a = s.index('  // Preprocess vision blocks')
b = s.index('  const prompt = messagesToPrompt', a)
s = s[:a] + s[b:]
s = s.replace("|| '1100380000020899'", "|| ''")
s = s.replace('    const candidate = candidates[i];', '    signal?.throwIfAborted();\n    const candidate = candidates[i];')
s = s.replace('      lastError = err;', '      signal?.throwIfAborted();\n      lastError = err;')
s = s.replace('            timeout: 120000,', '            signal,\n            timeout: 120000,')
s = s.replace('      let parsed = null;', "      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ClickUp gateway`);\n      let parsed = null;")
s = s.replace('      const errors = parsed?.data?.aiRequest?.errors;', "      if (!parsed) throw new Error('Invalid JSON from ClickUp gateway');\n      const errors = parsed?.data?.aiRequest?.errors;")
a = s.index('  // Nếu tất cả candidate')
b = s.index('\n}', a)
s = s[:a] + "  throw lastError || new Error('ClickUp returned empty completions for all candidate models');" + s[b:]
p.write_text(s, encoding='utf-8')
print('Isolated state; removed destructive workspace lifecycle, background jobs, vision and hệ thống rewriting')
