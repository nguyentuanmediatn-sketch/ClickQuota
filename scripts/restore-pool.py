from pathlib import Path

source_path = Path(r'C:\Users\hacke\Desktop\ProxyPM\SharkPool\ProxyClaude-main\src\clickup-pool.mjs')
dest_path = Path(r'C:\Users\hacke\Desktop\ClickQuota\src\clickup-pool.mjs')

s = source_path.read_text(encoding='utf-8')

# Replace state file & fs imports with config.mjs helpers
s = s.replace("import fs from 'node:fs';\nimport path from 'node:path';", "import { readPoolConfig, persistPoolConfig } from './config.mjs';")
s = s.replace("const STATE_FILE = path.join(process.cwd(), '.state', 'clickup_config.json');", "")

# Remove hardcoded workspace IDs
s = s.replace("workspaceId: '1100380000020899'", "workspaceId: ''")
s = s.replace("|| '1100380000020899'", "|| ''")
s = s.replace("|| '1100380000020790'", "|| ''")

# Add safety try-catch around pacing release
s = s.replace(
    'await this._applyAdaptiveMicroPacing(ws, poolSaturation, signal);',
    'try {\n      await this._applyAdaptiveMicroPacing(ws, poolSaturation, signal);\n    } catch (err) {\n      releaseQueue();\n      throw err;\n    }'
)

# Connect to ClickQuota's isolated config
old_loader = """function loadConfigFromFile() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn(`[ClickUpPool] Không thể đọc ${STATE_FILE}: ${err.message}. Dùng cấu hình mặc định.`);
  }
  return { workspaces: [], accounts: [] };
}

function saveConfigToFile(updates) {
  try {
    let current = {};
    if (fs.existsSync(STATE_FILE)) {
      try {
        current = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      } catch {}
    }
    const merged = {
      ...current,
      workspaces: updates.workspaces || current.workspaces || [],
      accounts: updates.accounts || current.accounts || [],
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.error(`[ClickUpPool] Lỗi ghi ${STATE_FILE}: ${err.message}`);
  }
}"""

new_loader = """function loadConfigFromFile() {
  try {
    return readPoolConfig();
  } catch {
    return { workspaces: [], accounts: [] };
  }
}

function saveConfigToFile(updates) {
  try {
    persistPoolConfig(updates);
  } catch (err) {
    console.error(`[ClickUpPool] Lỗi lưu trạng thái: ${err.message}`);
  }
}"""

s = s.replace(old_loader, new_loader)

dest_path.write_text(s, encoding='utf-8')
print(f"Successfully restored full clickup-pool.mjs in ClickQuota ({len(s)} chars)")
