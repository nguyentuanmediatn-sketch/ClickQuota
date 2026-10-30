// ClickQuota Admin Dashboard JavaScript Client (New-API & Sharkpool Standard)
const $ = (id) => document.getElementById(id);

// Bảo mật 2026-10-28: KHÔNG còn mật khẩu master hardcode phía client.
// Xác thực admin dùng gateway API key (operator nhập một lần vào sessionStorage)
// hoặc CLICKQUOTA_MASTER_PASSWORD đặt qua biến môi trường server (nhập tay khi được hỏi).
function authHeaders() {
  const token = sessionStorage.getItem('clickquota-api-key') || '';
  return {
    'content-type': 'application/json',
    'Authorization': 'Bearer ' + token,
    'x-api-key': token,
    'x-admin-key': token,
  };
}

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 2026-10-28 (P2 verify fix): JSON.stringify một mình KHÔNG an toàn trong attribute
// double-quoted — dấu " trong value đóng attribute sớm (HTML không hiểu \").
// Phải escapeHtml SAU stringify: &quot; round-trip về " khi JS parse attribute.
function jsStr(value) {
  return escapeHtml(JSON.stringify(value ?? ''));
}

// ── Navigation & Sidebar Tab Switcher ──────────────────────────────
window.switchTab = function(tabName) {
  const panes = document.querySelectorAll('.tab-pane');
  panes.forEach(p => p.classList.remove('active'));
  const targetPane = document.getElementById('view-' + tabName);
  if (targetPane) targetPane.classList.add('active');

  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(n => {
    if (n.getAttribute('data-tab') === tabName) {
      n.classList.add('active');
    } else {
      n.classList.remove('active');
    }
  });

  const titleEl = document.getElementById('topbar-title');
  if (titleEl) {
    const titles = {
      dashboard: '📊 Tổng quan hệ thống',
      keys: '🔑 Quản lý API Keys (Sharkpool)',
      channels: '⚡ Channels / Upstream ClickUp Pool',
      logs: '📋 Lịch sử gọi API & Diagnostics',
      settings: '⚙️ Cài đặt hệ thống & Agent Playground',
    };
    titleEl.textContent = titles[tabName] || 'ClickQuota Dashboard';
  }

  localStorage.setItem('clickquota_active_tab', tabName);
  if (tabName === 'keys') window.loadKeysHub();
  if (tabName === 'logs') fetchLogs();
};

window.resetAdminAuth = function() {
  const curr = sessionStorage.getItem('clickquota-api-key') || '';
  const entered = prompt('Nhập API key quản trị (hoặc CLICKQUOTA_MASTER_PASSWORD nếu server cấu hình):', curr);
  if (entered && entered.trim()) {
    sessionStorage.setItem('clickquota-api-key', entered.trim());
    alert('Đã cập nhật mã khóa Admin thành công!');
    window.loadClickUpHub(true);
    window.loadKeysHub();
  }
};

// ── Sharkpool API Key Management ──────────────────────────────
let cachedKeys = [];

window.loadKeysHub = async function() {
  try {
    const res = await fetch('/admin/api/keys', {
      headers: authHeaders(),
      cache: 'no-store'
    });
    if (!res.ok) {
      console.warn('Load keys failed:', res.status);
      return;
    }
    const data = await res.json();
    cachedKeys = data.keys || [];
    renderKeysTable(cachedKeys);
    updateKeysKPI(cachedKeys);
  } catch (err) {
    console.error('Error loading Sharkpool keys:', err);
  }
};

function renderKeysTable(keys) {
  const tbody = $('sharkpool-keys-table-body');
  if (!tbody) return;
  if (!keys || keys.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding: 24px; text-align: center; color: var(--text-muted);">Chưa có API Key nào. Hãy bấm nút [➕ Tạo API Key Mới] ở trên!</td></tr>`;
    return;
  }
  tbody.innerHTML = keys.map(k => {
    const isAct = k.active !== false;
    const activeBadge = isAct
      ? `<span class="badge badge-healthy" style="font-size: 11px;">Hoạt động</span>`
      : `<span class="badge badge-danger" style="font-size: 11px;">Đã khóa</span>`;
    const roleBadge = k.role === 'admin'
      ? `<span class="badge" style="background: rgba(99, 102, 241, 0.2); color: #a5b4fc; font-size: 10px;">Admin</span>`
      : `<span class="badge" style="background: rgba(148, 163, 184, 0.15); color: #94a3b8; font-size: 10px;">User</span>`;
    const usageStr = k.requestLimit ? `${k.requestsCount || 0} / ${k.requestLimit}` : `${k.requestsCount || 0} / ∞`;
    const tokenStr = k.tokenLimit ? `${k.tokensUsed || 0} / ${k.tokenLimit}` : `${k.tokensUsed || 0} / ∞`;
    const timeStr = k.createdAt ? new Date(k.createdAt).toLocaleDateString() : '--';
    const maskedKey = k.masked || '••••••••';
    const idArg = jsStr(k.id);
    const labelArg = jsStr(k.label || '');

    return `
      <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05); transition: background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
        <td style="padding: 12px 14px; font-weight: 600; color: #fff;">${escapeHtml(k.label || 'Gateway Key')}</td>
        <td style="padding: 12px 14px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <code class="key-mono" id="key-text-${escapeHtml(k.id)}">${escapeHtml(maskedKey)}</code>
            <span style="font-size: 10px; color: var(--text-muted);" title="Plaintext key chỉ hiển thị một lần duy nhất ngay sau khi tạo">masked</span>
          </div>
        </td>
        <td style="padding: 12px 14px;">${roleBadge}</td>
        <td style="padding: 12px 14px; font-weight: 600; color: #38bdf8;">${usageStr}</td>
        <td style="padding: 12px 14px; color: #c084fc;">${tokenStr}</td>
        <td style="padding: 12px 14px;">${activeBadge}</td>
        <td style="padding: 12px 14px; color: var(--text-muted);">${timeStr}</td>
        <td style="padding: 12px 14px; text-align: right;">
          <div style="display: inline-flex; gap: 6px;">
            <button type="button" class="btn-ghost" style="padding: 3px 8px; font-size: 11px; ${isAct ? 'color: #fbbf24;' : 'color: #34d399;'}" onclick="toggleSharkpoolKey(${idArg}, ${!isAct})">
              ${isAct ? 'Tắt' : 'Bật'}
            </button>
            <button type="button" class="btn-ghost" style="padding: 3px 8px; font-size: 11px; color: #f87171;" onclick="deleteSharkpoolKey(${idArg}, ${labelArg})">
              Xóa
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function updateKeysKPI(keys) {
  const activeCount = keys.filter(k => k.active !== false).length;
  const totalRequests = keys.reduce((sum, k) => sum + (k.requestsCount || 0), 0);
  const totalTokens = keys.reduce((sum, k) => sum + (k.tokensUsed || 0), 0);

  if ($('nav-badge-keys')) $('nav-badge-keys').textContent = activeCount;
  if ($('dash-active-keys-count')) $('dash-active-keys-count').textContent = `${activeCount} / ${keys.length}`;
  if ($('dash-total-requests-count')) $('dash-total-requests-count').textContent = totalRequests;
  if ($('dash-total-tokens-count')) $('dash-total-tokens-count').textContent = totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens;

  const sessionKey = sessionStorage.getItem('clickquota-api-key') || '';
  const keyToUse = sessionKey ? sessionKey : '<DÁN-API-KEY-QUẢN-TRỊ-CỦA-BẠN>';
  const curlCode = `curl http://127.0.0.1:4310/v1/responses \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer ${keyToUse}" \\\n  -d '{"model": "gpt-6.1-sol-CL", "input": "Xin chào ClickQuota!"}'`;
  if ($('curl-example-code')) $('curl-example-code').textContent = curlCode;
}

window.openCreateKeyModal = function() {
  const modal = $('modal-create-key');
  if (modal) modal.style.display = 'flex';
  if ($('new-key-label')) $('new-key-label').value = '';
  if ($('new-key-req-limit')) $('new-key-req-limit').value = '';
  if ($('new-key-token-limit')) $('new-key-token-limit').value = '';
};

window.closeCreateKeyModal = function() {
  const modal = $('modal-create-key');
  if (modal) modal.style.display = 'none';
};

window.submitCreateKey = async function() {
  const label = $('new-key-label')?.value.trim();
  const role = $('new-key-role')?.value || 'user';
  const reqLimit = $('new-key-req-limit')?.value.trim();
  const tokenLimit = $('new-key-token-limit')?.value.trim();

  try {
    const res = await fetch('/admin/api/keys/create', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        label: label || 'New API Key',
        role,
        requestLimit: reqLimit ? Number(reqLimit) : null,
        tokenLimit: tokenLimit ? Number(tokenLimit) : null,
      })
    });
    const data = await res.json();
    if (!data.ok) {
      alert('Lỗi tạo key: ' + (data.error || 'Thao tác thất bại'));
      return;
    }
    closeCreateKeyModal();
    await window.loadKeysHub();
    if (data.key && data.key.key) {
      navigator.clipboard.writeText(data.key.key);
      alert(`🎉 Đã tạo API Key thành công (Chuẩn OpenAI):\n\n${data.key.key}\n\n(Key đã được tự động copy vào Clipboard của bạn!)`);
    }
  } catch (err) {
    alert('Lỗi kết nối khi tạo key: ' + err.message);
  }
};

window.toggleSharkpoolKey = async function(id, active) {
  try {
    const res = await fetch('/admin/api/keys/toggle', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id, active })
    });
    const data = await res.json();
    if (data.ok) {
      await window.loadKeysHub();
    } else {
      alert('Lỗi cập nhật trạng thái key: ' + data.error);
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  }
};

window.deleteSharkpoolKey = async function(id, label) {
  if (!confirm(`Bạn có chắc chắn muốn xóa API Key "${label}"? Thao tác này không thể hoàn tác.`)) {
    return;
  }
  try {
    const res = await fetch(`/admin/api/keys?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    const data = await res.json();
    if (data.ok) {
      await window.loadKeysHub();
    } else {
      alert('Lỗi khi xóa key: ' + data.error);
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  }
};

window.copyKeyToClipboard = async function(keyStr, btn) {
  try {
    await navigator.clipboard.writeText(keyStr);
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    btn.style.color = '#34d399';
    setTimeout(() => {
      btn.textContent = orig;
      btn.style.color = '';
    }, 1500);
  } catch (err) {
    prompt('Copy key thủ công tại đây:', keyStr);
  }
};

window.copyCurlExample = async function() {
  const code = $('curl-example-code')?.textContent || '';
  if (code) {
    await navigator.clipboard.writeText(code);
    alert('Đã copy lệnh cURL vào clipboard!');
  }
};

// ── Channels & ClickUp Workspaces / Accounts Pool ─────────────────
let cachedWorkspaces = [];
let cachedAccounts = [];

window.loadClickUpHub = async function(refresh = false) {
  try {
    const query = refresh ? '?refresh=1' : '';
    const res = await fetch('/admin/api/clickup/status' + query, {
      headers: authHeaders(),
      cache: 'no-store'
    });

    if (res.status === 401 || res.status === 403) {
      const key = prompt('Vui lòng nhập API Key quản trị (gateway key hoặc CLICKQUOTA_MASTER_PASSWORD):', sessionStorage.getItem('clickquota-api-key') || '');
      if (key) {
        sessionStorage.setItem('clickquota-api-key', key.trim());
        return window.loadClickUpHub(refresh);
      }
      return;
    }

    const data = await res.json();
    if (!data.ok) {
      console.error('ClickUp Status Error:', data.error);
      return;
    }

    const workspaces = data.workspaces || [];
    const accounts = data.accounts || [];
    const summary = data.summary || {};

    cachedWorkspaces = workspaces;
    cachedAccounts = accounts;

    // Header Badges
    if ($('clickup-badge-count')) $('clickup-badge-count').textContent = `${workspaces.length} WS`;
    if ($('nav-badge-ws')) $('nav-badge-ws').textContent = workspaces.length;
    if ($('nav-badge-channels')) $('nav-badge-channels').textContent = `${workspaces.length}/${accounts.length}`;

    // 1. Workspaces Ready
    const activeWs = workspaces.filter(w => w.enabled && !w.isCooldown).length;
    const cdWs = workspaces.filter(w => w.isCooldown).length;
    if ($('clickup-stat-ws')) $('clickup-stat-ws').textContent = `${activeWs} / ${workspaces.length} Active`;
    if ($('clickup-stat-ws-sub')) $('clickup-stat-ws-sub').textContent = cdWs > 0 ? `⚠️ ${cdWs} đang cooldown` : `✅ Không có workspace cooldown`;

    // 2. Quota Daily
    let dailyLeft = summary.dailyLeft || 0;
    let dailyLimit = summary.dailyLimit || 0;
    let dailyUsage = summary.dailyUsage || 0;
    const hasDaily = (dailyLimit > 0) || workspaces.some(w => w.quota?.dailyLimit);
    if (!hasDaily) {
      if ($('clickup-stat-quota-daily')) $('clickup-stat-quota-daily').textContent = `-- / --`;
      if ($('clickup-stat-quota-daily-sub')) $('clickup-stat-quota-daily-sub').textContent = `Chưa kiểm tra (Bấm [Kiểm tra sức khỏe])`;
    } else {
      if ($('clickup-stat-quota-daily')) $('clickup-stat-quota-daily').textContent = `${dailyLeft.toLocaleString()} tokens`;
      if ($('clickup-stat-quota-daily-sub')) $('clickup-stat-quota-daily-sub').textContent = `Dùng: ${dailyUsage.toLocaleString()} / ${dailyLimit.toLocaleString()} • Reset 07:00 sáng (giờ VN)`;
    }

    // 3. Quota Weekly
    let weeklyLeft = summary.weeklyLeft || 0;
    let weeklyLimit = summary.weeklyLimit || 0;
    let weeklyUsage = summary.weeklyUsage || 0;
    const hasWeekly = (weeklyLimit > 0) || workspaces.some(w => w.quota?.weeklyLimit);
    if (!hasWeekly) {
      if ($('clickup-stat-quota-weekly')) $('clickup-stat-quota-weekly').textContent = `-- / --`;
      if ($('clickup-stat-quota-weekly-sub')) $('clickup-stat-quota-weekly-sub').textContent = `Chưa kiểm tra quota tuần`;
    } else {
      if ($('clickup-stat-quota-weekly')) $('clickup-stat-quota-weekly').textContent = `${weeklyLeft.toLocaleString()} tokens`;
      if ($('clickup-stat-quota-weekly-sub')) $('clickup-stat-quota-weekly-sub').textContent = `Dùng: ${weeklyUsage.toLocaleString()} / ${weeklyLimit.toLocaleString()} • Reset thứ Hai`;
    }

    // 4. Session Token Exp
    let minExpH = Infinity;
    const now = Date.now();
    for (const ws of workspaces) {
      if (ws.tokenExpHoursLeft != null && ws.tokenExpHoursLeft < minExpH) {
        minExpH = ws.tokenExpHoursLeft;
      } else if (ws.tokenExp) {
        const diffH = (new Date(ws.tokenExp).getTime() - now) / 3600000;
        if (diffH < minExpH) minExpH = diffH;
      }
    }
    if (minExpH !== Infinity && minExpH > 0) {
      if ($('clickup-stat-exp')) $('clickup-stat-exp').textContent = `~${minExpH.toFixed(1)}h còn lại`;
    } else if (workspaces.length > 0) {
      if ($('clickup-stat-exp')) $('clickup-stat-exp').textContent = `~24h - 48h`;
    } else {
      if ($('clickup-stat-exp')) $('clickup-stat-exp').textContent = `--`;
    }

    // 5. Concurrency
    const totalInFlight = workspaces.reduce((sum, w) => sum + (w.inFlight || w.activeRequests || 0), 0);
    const maxCapacity = workspaces.length * 3;
    if ($('clickup-stat-concurrency')) $('clickup-stat-concurrency').textContent = `${totalInFlight} / ${maxCapacity} In-Flight`;

    // 6. Accounts
    const validAccs = accounts.filter(a => a.enabled !== false && (a.hasCuRefresh || a.cuRefresh)).length;
    if ($('clickup-stat-accounts')) $('clickup-stat-accounts').textContent = `${validAccs} / ${accounts.length} Accounts`;
    if ($('clickup-stat-accounts-sub')) $('clickup-stat-accounts-sub').textContent = `${accounts.length} tài khoản mẹ liên kết`;

    // Quota thật theo lỗi upstream (không chỉ entitlement): workspace nào bị cách ly
    // vì quota ẩn sẽ hiện lý do + giờ hết cách ly, tránh nhìn số entitlement mà tưởng còn quota.
    const blockedEl = $('dash-quota-blocked-alert');
    if (blockedEl) {
      const blocked = summary.quotaBlockedWorkspaces || [];
      if (blocked.length > 0) {
        blockedEl.style.display = 'block';
        blockedEl.innerHTML = '<strong>⚠️ Quota thật đang chặn ' + blocked.length + ' workspace:</strong> ' + blocked.map(w => {
          const until = w.cooldownUntil ? new Date(w.cooldownUntil).toLocaleTimeString('vi-VN') : '';
          const reason = w.cooldownReason || (w.quotaStatus === 'exhausted' ? 'Hết quota (exhausted)' : 'Đang cách ly');
          return escapeHtml(w.label || w.workspaceId) + ' — ' + escapeHtml(reason) + (until ? ' (đến ' + until + ')' : '') + ' • entitlement còn ' + (w.entitlementDailyLeft ?? '?') + ' token (con số này có thể sai lệch so với upstream)';
        }).join('<br>');
      } else {
        blockedEl.style.display = 'none';
      }
    }

    renderWorkspacesTable(workspaces, accounts);
    renderAccountsTable(accounts, workspaces);
    updateWorkspaceDropdowns(workspaces, accounts);
  } catch (err) {
    console.error('loadClickUpHub error:', err);
  }
};

function renderWorkspacesTable(workspaces, accounts) {
  const tbody = $('clickup-workspaces-table-body');
  if (!tbody) return;

  if (workspaces.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding: 24px; text-align: center; color: var(--text-muted);">Chưa có Workspace nào được nạp. Hãy bấm <strong>[➕ Thêm Workspace Mới]</strong>!</td></tr>`;
    return;
  }

  const accMap = new Map();
  for (const a of accounts) {
    accMap.set(String(a.id), a);
    if (a.userId) accMap.set(String(a.userId), a);
  }

  tbody.innerHTML = workspaces.map(ws => {
    const q = ws.quota || {};
    const dLeft = q.dailyLeft ?? '--';
    const dLim = q.dailyLimit ?? '--';
    const wLeft = q.weeklyLeft ?? '--';
    const wLim = q.weeklyLimit ?? '--';

    const isExhausted = ws.quotaStatus === 'exhausted' || q.isBlocked;
    const isCooldown = ws.isCooldown;

    let statusBadge = '<span class="badge badge-healthy">Sẵn sàng</span>';
    if (isExhausted) {
      statusBadge = '<span class="badge badge-danger">Hết Quota</span>';
    } else if (isCooldown) {
      statusBadge = '<span class="badge badge-danger">Cooldown</span>';
    } else if (!ws.enabled) {
      statusBadge = '<span class="badge" style="background: rgba(255,255,255,0.1); color: var(--text-muted);">Đã tắt</span>';
    }

    const expText = ws.tokenExpHoursLeft != null ? `~${ws.tokenExpHoursLeft}h` : (ws.tokenExp ? new Date(ws.tokenExp).toLocaleDateString() : '--');

    const isMax23 = typeof dLim === 'number' && dLim >= 400000;
    const planBadge = isMax23
      ? '<span class="badge" style="background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); font-size: 10px; margin-left: 6px; vertical-align: middle;">MAX 23</span>'
      : (typeof dLim === 'number' && dLim <= 1000 ? '<span class="badge" style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); font-size: 10px; margin-left: 6px; vertical-align: middle;">Free / Lệch</span>' : '');

    return `
      <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05); transition: background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
        <td style="padding: 10px 12px;">
          <div style="font-weight: 600; color: #fff; display: flex; align-items: center;">${escapeHtml(ws.label || 'Workspace')}${planBadge}</div>
          <div style="font-size: 11px; color: var(--text-muted); font-family: monospace;">ID: ${escapeHtml(ws.workspaceId)}</div>
        </td>
        <td style="padding: 10px 12px; color: #38bdf8; font-weight: 600;">${typeof dLeft === 'number' ? dLeft.toLocaleString() : dLeft} / ${typeof dLim === 'number' ? dLim.toLocaleString() : dLim}</td>
        <td style="padding: 10px 12px; color: #a7f3d0;">${typeof wLeft === 'number' ? wLeft.toLocaleString() : wLeft} / ${typeof wLim === 'number' ? wLim.toLocaleString() : wLim}</td>
        <td style="padding: 10px 12px; color: #34d399;">${expText}</td>
        <td style="padding: 10px 12px; color: #f59e0b;">${ws.inFlight || ws.activeRequests || 0} req</td>
        <td style="padding: 10px 12px;">${statusBadge}</td>
        <td style="padding: 10px 12px; text-align: right;">
          <div style="display: inline-flex; gap: 6px;">
            <button type="button" class="btn-ghost" style="padding: 3px 8px; font-size: 11px;" onclick="renewWs(${jsStr(ws.id)})" title="Gia hạn Session">🔄</button>
            <button type="button" class="btn-ghost" style="padding: 3px 8px; font-size: 11px;" onclick="toggleWs(${jsStr(ws.id)}, ${!ws.enabled})">${ws.enabled ? 'Tắt' : 'Bật'}</button>
            <button type="button" class="btn-ghost" style="padding: 3px 8px; font-size: 11px; color: #f87171;" onclick="deleteWs(${jsStr(ws.id)})">Xóa</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function renderAccountsTable(accounts, workspaces) {
  const tbody = $('clickup-accounts-table-body');
  if (!tbody) return;

  if (accounts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding: 24px; text-align: center; color: var(--text-muted);">Chưa có Tài khoản mẹ nào. Hãy bấm <strong>[➕ Thêm Tài Khoản]</strong>!</td></tr>`;
    return;
  }

  tbody.innerHTML = accounts.map(acc => {
    const hasRefresh = Boolean(acc.hasCuRefresh ?? acc.cuRefresh);
    const linkedWsCount = workspaces.filter(w => String(w.accountId) === String(acc.id) || String(w.accountId) === String(acc.userId)).length;

    return `
      <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05); transition: background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.02)'" onmouseout="this.style.background='transparent'">
        <td style="padding: 10px 12px; font-weight: 600; color: #fff;">${escapeHtml(acc.email || acc.label || 'Tài khoản ClickUp')}</td>
        <td style="padding: 10px 12px; font-family: monospace; color: var(--text-muted);">${acc.userId || '--'}</td>
        <td style="padding: 10px 12px;">${hasRefresh ? '<span class="badge badge-healthy">Đã nạp</span>' : '<span class="badge badge-danger">Thiếu</span>'}</td>
        <td style="padding: 10px 12px; color: #a78bfa;">${linkedWsCount} Workspaces</td>
        <td style="padding: 10px 12px;">${acc.enabled !== false ? '<span class="badge badge-healthy">Hoạt động</span>' : '<span class="badge badge-danger">Khóa</span>'}</td>
        <td style="padding: 10px 12px; text-align: right;">
          <div style="display: inline-flex; gap: 6px;">
            <button class="btn-ghost" style="padding: 3px 8px; font-size: 11px; color: #a78bfa;" onclick="testAccountCookie(${jsStr(acc.id)}, ${jsStr(acc.email || '')})">🔍 Test</button>
            <button class="btn-ghost" style="padding: 3px 8px; font-size: 11px; color: #34d399;" onclick="recreateSingleAccount(${jsStr(acc.id)}, ${jsStr(acc.email || '')})">⚡ Recreate</button>
            <button class="btn-ghost" style="padding: 3px 8px; font-size: 11px; color: #f87171;" onclick="deleteAccount(${jsStr(acc.id)})">Xóa</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function updateWorkspaceDropdowns(workspaces, accounts) {
  const wsSelect = $('pg-ws-select');
  if (!wsSelect) return;
  const currentVal = wsSelect.value;
  wsSelect.innerHTML = `<option value="">-- Tự động chọn Workspace tối ưu nhất --</option>`;
  for (const ws of workspaces) {
    if (!ws.enabled) continue;
    const opt = document.createElement('option');
    opt.value = ws.workspaceId || ws.id;
    opt.textContent = `${ws.label || ws.workspaceId} (Còn: ${ws.quota?.dailyLeft ?? '--'} tokens)`;
    wsSelect.appendChild(opt);
  }
  if (currentVal) wsSelect.value = currentVal;
}

// ── Workspace & Account Operation Helpers ─────────────────────────
window.renewWs = async function(id) {
  try {
    const res = await fetch('/admin/api/clickup/workspaces/renew', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (data.ok) {
      alert('Gia hạn session token thành công!');
      window.loadClickUpHub(true);
    } else {
      alert('Lỗi gia hạn: ' + data.error);
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  }
};

window.toggleWs = async function(id, enabled) {
  try {
    await fetch('/admin/api/clickup/workspaces/toggle', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id, enabled })
    });
    window.loadClickUpHub(true);
  } catch (err) {
    alert('Lỗi bật/tắt workspace: ' + err.message);
  }
};

window.deleteWs = async function(id) {
  if (!confirm('Bạn có chắc muốn xóa Workspace này khỏi Pool?')) return;
  try {
    await fetch('/admin/api/clickup/workspaces?id=' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: authHeaders()
    });
    window.loadClickUpHub(true);
  } catch (err) {
    alert('Lỗi xóa workspace: ' + err.message);
  }
};

window.deleteAccount = async function(id) {
  if (!confirm('Bạn có chắc muốn xóa Tài khoản này khỏi Pool?')) return;
  try {
    await fetch('/admin/api/clickup/accounts?id=' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: authHeaders()
    });
    window.loadClickUpHub(true);
  } catch (err) {
    alert('Lỗi xóa account: ' + err.message);
  }
};

window.testAccountCookie = async function(id, email) {
  try {
    const res = await fetch('/admin/api/clickup/accounts/verify', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (data.ok && data.verified?.valid) {
      alert(`✅ Tài khoản "${email}" hợp lệ và kết nối tốt với ClickUp!`);
    } else {
      alert(`⚠️ Kiểm tra thất bại: ${data.error || 'Cookie cu_refresh hết hạn'}`);
    }
  } catch (err) {
    alert('Lỗi khi kiểm tra tài khoản: ' + err.message);
  }
};

window.recreateSingleAccount = async function(id, email) {
  if (!confirm(`Bắt đầu tự động tái tạo Workspace cho tài khoản "${email}"?`)) return;
  try {
    const res = await fetch('/admin/api/clickup/auto-recreate', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ accountId: id, count: 5 })
    });
    const data = await res.json();
    if (data.ok) {
      alert('Tái tạo Workspace thành công!');
      window.loadClickUpHub(true);
    } else {
      alert('Lỗi tái tạo: ' + data.error);
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  }
};

// Batch Health Check & Ping Pool
const pingBtn = $('clickup-ping-all-btn');
const pingIcon = $('clickup-ping-all-icon');
const pingText = $('clickup-ping-all-text');
if (pingBtn) {
  pingBtn.addEventListener('click', async () => {
    try {
      pingBtn.disabled = true;
      if (pingIcon) pingIcon.textContent = '⏳';
      if (pingText) pingText.textContent = 'Đang kiểm tra sức khỏe toàn pool...';

      const res = await fetch('/admin/api/clickup/quota/refresh', {
        method: 'POST',
        headers: authHeaders()
      });
      await window.loadClickUpHub(true);

      if (pingIcon) pingIcon.textContent = '✅';
      if (pingText) pingText.textContent = 'Sức khỏe Pool: Đã đồng bộ!';
      setTimeout(() => {
        if (pingIcon) pingIcon.textContent = '⚡';
        if (pingText) pingText.textContent = 'Kiểm Tra Sức Khỏe Toàn Pool';
        pingBtn.disabled = false;
      }, 2500);
    } catch (err) {
      console.error('Ping pool error:', err);
      if (pingIcon) pingIcon.textContent = '⚠️';
      if (pingText) pingText.textContent = 'Lỗi: ' + err.message;
      setTimeout(() => {
        if (pingIcon) pingIcon.textContent = '⚡';
        if (pingText) pingText.textContent = 'Kiểm Tra Sức Khỏe Toàn Pool';
        pingBtn.disabled = false;
      }, 3500);
    }
  });
}

// Auto Recreate All Workspaces
$('clickup-auto-recreate-btn')?.addEventListener('click', async () => {
  // Bước 1: xem trước (chỉ đọc) — liệt kê giữ/xóa/tạo trước khi đụng tới tài khoản thật.
  let preview;
  try {
    const res = await fetch('/admin/api/clickup/auto-recreate/preview', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ count: 10 })
    });
    const data = await res.json();
    if (!data.ok) { alert('Không xem trước được: ' + (data.error || 'lỗi không rõ')); return; }
    preview = data.preview;
  } catch (err) { alert('Lỗi xem trước: ' + err.message); return; }
  const lines = [];
  for (const a of preview.accounts || []) {
    if (a.error) { lines.push('• ' + a.email + ': ' + a.error); continue; }
    lines.push('• Tài khoản ' + a.email + ' (prefix ' + a.prefix + ')');
    lines.push('  GIỮ: ' + (a.keep || []).map(w => w.name + ' (' + w.id + ')').join(', '));
    if ((a.keepOther || []).length) lines.push('  GIỮ THÊM (tùy chỉnh, không xóa): ' + a.keepOther.map(w => w.name).join(', '));
    lines.push('  XÓA: ' + ((a.delete || []).length ? a.delete.map(w => w.name + ' (' + w.id + ')').join(', ') : 'không có'));
    lines.push('  TẠO MỚI: ' + ((a.create || []).length ? a.create.join(', ') : 'không có'));
    if (a.warning) lines.push('  ⚠️ ' + a.warning);
  }
  lines.push('');
  lines.push('Tổng: xóa ' + preview.totalDelete + ' workspace, tạo ' + preview.totalCreate + ' workspace mới.');
  if (!confirm('XEM TRƯỚC AUTO-RECREATE (chưa chạy gì cả):\n\n' + lines.join('\n') + '\n\nBấm OK để CHẠY THẬT. Thao tác xóa workspace không thể hoàn tác.')) return;
  try {
    const res = await fetch('/admin/api/clickup/auto-recreate', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ count: 10 })
    });
    const data = await res.json();
    if (data.ok) {
      alert('Kích hoạt Auto Recreate thành công!');
      window.loadClickUpHub(true);
    } else {
      alert('Lỗi: ' + data.error);
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  }
});

// Modals Listeners: Add Workspace & Add Account
$('clickup-add-ws-btn')?.addEventListener('click', () => {
  const m = $('clickup-add-ws-modal');
  if (m) m.style.display = 'flex';
});

$('clickup-ws-save-btn')?.addEventListener('click', async () => {
  const rawCurl = $('clickup-ws-rawcurl')?.value.trim();
  const workspaceId = $('clickup-ws-id')?.value.trim();
  const label = $('clickup-ws-label')?.value.trim();
  const token = $('clickup-ws-token')?.value.trim();

  if (!rawCurl && (!workspaceId || !token)) {
    alert('Vui lòng dán lệnh cURL hoặc nhập Workspace ID và Token!');
    return;
  }

  try {
    const res = await fetch('/admin/api/clickup/workspaces/add', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ rawCurl, workspaceId, label, token })
    });
    const data = await res.json();
    if (data.ok) {
      $('clickup-add-ws-modal').style.display = 'none';
      alert('Thêm Workspace thành công!');
      window.loadClickUpHub(true);
    } else {
      alert('Lỗi: ' + data.error);
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  }
});

$('clickup-add-acc-btn')?.addEventListener('click', () => {
  const m = $('clickup-add-acc-modal');
  if (m) m.style.display = 'flex';
});

$('clickup-acc-save-btn')?.addEventListener('click', async () => {
  const rawCurl = $('clickup-acc-rawcurl')?.value.trim();
  const cuRefresh = $('clickup-acc-curefresh')?.value.trim();
  const email = $('clickup-acc-email')?.value.trim();
  const label = $('clickup-acc-label')?.value.trim();

  if (!rawCurl && !cuRefresh) {
    alert('Vui lòng dán lệnh cURL hoặc chuỗi cu_refresh!');
    return;
  }

  try {
    const res = await fetch('/admin/api/clickup/accounts/add', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ rawCurl, cuRefresh, email, label })
    });
    const data = await res.json();
    if (data.ok) {
      $('clickup-add-acc-modal').style.display = 'none';
      alert('Thêm tài khoản thành công!');
      window.loadClickUpHub(true);
    } else {
      alert('Lỗi: ' + (data.error || 'Xác thực thất bại'));
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  }
});

// Auto Refresh ClickUp Pool
let clickupAutoRefreshEnabled = true;
function setupClickUpAutoRefresh() {
  const toggleBtn = $('btn-clickup-autorefresh-toggle');
  const dot = $('autorefresh-dot');
  const label = $('autorefresh-label');

  toggleBtn?.addEventListener('click', () => {
    clickupAutoRefreshEnabled = !clickupAutoRefreshEnabled;
    if (clickupAutoRefreshEnabled) {
      if (dot) dot.textContent = '🟢';
      if (label) label.textContent = 'Auto-Refresh: Bật (3s)';
      toggleBtn.style.color = '#34d399';
    } else {
      if (dot) dot.textContent = '⏸️';
      if (label) label.textContent = 'Auto-Refresh: Tạm dừng';
      toggleBtn.style.color = '#fbbf24';
    }
  });

  setInterval(() => {
    if (clickupAutoRefreshEnabled && !document.hidden) {
      window.loadClickUpHub(false);
    }
  }, 3000);
}

// ── Super Agent & Playground ───────────────────────────────────────
function setupAgentPlayground() {
  const btnSend = $('pg-btn-send');
  if (!btnSend) return;

  btnSend.addEventListener('click', async () => {
    const prompt = $('pg-prompt')?.value.trim();
    if (!prompt) {
      alert('Vui lòng nhập nội dung prompt để thử nghiệm!');
      return;
    }

    const model = $('pg-model')?.value || 'super-agent-CL';
    const mode = $('pg-mode')?.value || 'chat';
    const workspaceId = $('pg-ws-select')?.value || null;

    btnSend.disabled = true;
    if ($('pg-spinner')) $('pg-spinner').style.display = 'block';
    if ($('pg-result-card')) $('pg-result-card').style.display = 'none';

    try {
      const endpoint = mode === 'agent' || mode === 'tools_completion'
        ? '/admin/api/clickup/agent/test'
        : '/admin/api/clickup/test';

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt, model, mode, workspaceId })
      });
      const data = await res.json();

      if ($('pg-spinner')) $('pg-spinner').style.display = 'none';
      if ($('pg-result-card')) $('pg-result-card').style.display = 'block';

      if ($('pg-res-badge')) {
        $('pg-res-badge').textContent = res.ok ? '200 OK' : `HTTP ${res.status}`;
        $('pg-res-badge').className = res.ok ? 'badge badge-healthy' : 'badge badge-danger';
      }
      if ($('pg-res-time')) $('pg-res-time').textContent = `⚡ ${data.latencyMs || 0}ms`;
      if ($('pg-res-model')) $('pg-res-model').textContent = `Model: ${data.model || model}`;
      if ($('pg-res-ws')) $('pg-res-ws').textContent = `Workspace: ${data.workspace || data.workspaceId || 'Auto'}`;

      if (data.thinking) {
        if ($('pg-box-thinking')) $('pg-box-thinking').style.display = 'block';
        if ($('pg-res-thinking')) $('pg-res-thinking').textContent = data.thinking;
      } else {
        if ($('pg-box-thinking')) $('pg-box-thinking').style.display = 'none';
      }

      if (data.toolCalls && data.toolCalls.length > 0) {
        if ($('pg-box-tools')) $('pg-box-tools').style.display = 'block';
        if ($('pg-res-tools')) $('pg-res-tools').textContent = JSON.stringify(data.toolCalls, null, 2);
      } else {
        if ($('pg-box-tools')) $('pg-box-tools').style.display = 'none';
      }

      if ($('pg-res-reply')) $('pg-res-reply').textContent = data.reply || data.error || '(Không có nội dung phản hồi)';
      if ($('pg-res-raw')) $('pg-res-raw').textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      if ($('pg-spinner')) $('pg-spinner').style.display = 'none';
      if ($('pg-result-card')) $('pg-result-card').style.display = 'block';
      if ($('pg-res-badge')) { $('pg-res-badge').textContent = 'ERROR'; $('pg-res-badge').className = 'badge badge-danger'; }
      if ($('pg-res-reply')) $('pg-res-reply').textContent = 'Lỗi: ' + err.message;
    } finally {
      btnSend.disabled = false;
    }
  });
}

// ── Realtime Request & Debug Logs Hub ──────────────────────────────
let logPaused = false;
let logData = { request: [], debug: [] };
let logKind = 'request';

async function fetchLogs() {
  try {
    const outcomeFilter = $('log-filter-outcome')?.value || '';
    const outcomeQuery = outcomeFilter ? `&outcome=${encodeURIComponent(outcomeFilter)}` : '';
    const toolOnly = $('log-filter-toolonly')?.checked ? '&toolOnly=1' : '';
    const toolParse = $('log-filter-toolparse')?.value || '';
    const toolParseQuery = toolParse ? `&toolParseStatus=${encodeURIComponent(toolParse)}` : '';
    const [resReq, resDebug] = await Promise.all([
      fetch(`/admin/api/logs?kind=request&limit=150${outcomeQuery}${toolOnly}${toolParseQuery}`, { headers: authHeaders(), cache: 'no-store' }),
      fetch(`/admin/api/logs?kind=debug&limit=150`, { headers: authHeaders(), cache: 'no-store' })
    ]);
    if (resReq.ok) {
      const d = await resReq.json();
      logData.request = (d.entries || []).slice().reverse();
    }
    if (resDebug.ok) {
      const d = await resDebug.json();
      logData.debug = (d.entries || []).slice().reverse();
    }
    renderLogs();
  } catch (err) {
    console.error('Fetch logs error:', err);
  }
}

function renderLogs() {
  if ($('log-count-req')) $('log-count-req').textContent = logData.request.length;
  if ($('log-count-debug')) $('log-count-debug').textContent = logData.debug.length;

  const reqs = logData.request;
  const total = reqs.length;
  const successCount = reqs.filter(r => r.outcome === 'success' || r.status === 200).length;
  const successRate = total > 0 ? Math.round((successCount / total) * 100) : 100;
  const totalDuration = reqs.reduce((acc, r) => acc + (Number(r.durationMs) || 0), 0);
  const avgLatency = total > 0 ? (totalDuration / total / 1000).toFixed(1) : '0';
  const totalTokens = reqs.reduce((acc, r) => acc + (Number(r.inputTokens) || 0) + (Number(r.outputTokens) || 0), 0);

  if ($('stat-log-total')) $('stat-log-total').textContent = total;
  if ($('stat-log-success')) $('stat-log-success').textContent = `${successRate}%`;
  if ($('stat-log-latency')) $('stat-log-latency').textContent = `${avgLatency}s`;
  if ($('stat-log-tokens')) $('stat-log-tokens').textContent = totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens;

  const search = ($('log-search-input')?.value || '').toLowerCase().trim();

  // Render Structured Cards View
  const cardsContainer = $('log-cards-container');
  if (cardsContainer) {
    const filtered = reqs.filter(r => {
      if (!search) return true;
      return (r.requestedModel || '').toLowerCase().includes(search) ||
             (r.resolvedModel || '').toLowerCase().includes(search) ||
             (r.requestId || '').toLowerCase().includes(search) ||
             (r.path || '').toLowerCase().includes(search) ||
             ((r.toolNames || []).join(' ').toLowerCase().includes(search));
    });

    if (filtered.length === 0) {
      cardsContainer.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-muted);">Không có request nào phù hợp bộ lọc.</div>`;
    } else {
      cardsContainer.innerHTML = filtered.map(r => {
        const timeStr = r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : '--:--:--';
        const isSuccess = r.outcome === 'success' || r.status === 200;
        const statusBadge = isSuccess
          ? `<span class="badge badge-healthy">200 OK</span>`
          : `<span class="badge badge-danger">${r.status || 'ERR'} ${r.outcome || ''}</span>`;
        const protoBadge = r.protocol === 'anthropic'
          ? `<span class="badge" style="background: rgba(168, 85, 247, 0.15); color: #d8b4fe; border: 1px solid rgba(168, 85, 247, 0.3);">Anthropic</span>`
          : `<span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3);">OpenAI</span>`;
                const shortId = escapeHtml((r.requestId || '').slice(0, 8));

        return `
          <div style="background: rgba(17, 24, 39, 0.7); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <span style="font-family: monospace; font-size: 11px; color: var(--text-muted); font-weight: 600;">${timeStr}</span>
                ${statusBadge}
                <span style="font-weight: 700; font-size: 11px; color: #fff;">${escapeHtml(r.method || 'POST')}</span>
                <code style="font-family: monospace; font-size: 11px; color: #38bdf8;">${escapeHtml(r.path || '')}</code>
                ${protoBadge}
                <span style="font-size: 11px; color: #a78bfa; font-weight: 600;">${escapeHtml(r.requestedModel || '')}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 12px;">
                <span style="font-size: 11px; color: #fbbf24; font-weight: 600;">⚡ ${r.durationMs || 0}ms</span>
                <span style="font-size: 11px; color: #c084fc;">🔤 ${r.inputTokens || 0} / ${r.outputTokens || 0} tok</span>
                <button type="button" class="btn-ghost" style="padding: 2px 8px; font-size: 10px;" onclick="const d = document.getElementById('log-json-${shortId}'); d.style.display = d.style.display === 'none' ? 'block' : 'none';">
                  🔍 JSON
                </button>
              </div>
            </div>
            <div style="font-size: 11px; color: #fbbf24;">${(r.toolCount || 0) > 0 ? '🔧 Tool: ' + escapeHtml((r.toolNames || []).join(', ')) + ' • arguments dài ' + escapeHtml((r.toolArgLengths || []).join(', ')) + ' ký tự • finish ' + escapeHtml(r.finishReason || '') + ' • parse ' + escapeHtml(r.toolParseStatus || '') : ((r.declaredToolNames || []).length > 0 ? '🔧 Đã khai ' + (r.declaredToolNames || []).length + ' tool (' + escapeHtml((r.declaredToolNames || []).join(', ')) + ') nhưng không trả toolcall • parse ' + escapeHtml(r.toolParseStatus || 'none') : '🔧 Không khai tool')}</div>
            <pre id="log-json-${shortId}" style="display: none; background: #070a12; border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-family: monospace; font-size: 10px; color: #93c5fd; white-space: pre-wrap; margin: 0;">${escapeHtml(JSON.stringify(r, null, 2))}</pre>
          </div>
        `;
      }).join('');
    }
  }

  // Render Table View
  const tbody = $('log-table-body');
  if (tbody) {
    const filtered = reqs.filter(r => {
      if (!search) return true;
      return (r.requestedModel || '').toLowerCase().includes(search) ||
             (r.resolvedModel || '').toLowerCase().includes(search) ||
             (r.requestId || '').toLowerCase().includes(search) ||
             (r.path || '').toLowerCase().includes(search) ||
             ((r.toolNames || []).join(' ').toLowerCase().includes(search));
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="padding: 24px; text-align: center; color: var(--text-muted);">Không có request nào phù hợp bộ lọc.</td></tr>`;
    } else {
      tbody.innerHTML = filtered.map(r => {
        const timeStr = r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : '--:--:--';
        const isSuccess = r.outcome === 'success' || r.status === 200;
        const statusBadge = isSuccess
          ? `<span class="badge badge-healthy">200 OK</span>`
          : `<span class="badge badge-danger">${r.status || 'ERR'} ${r.outcome || ''}</span>`;
        return `
          <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
            <td style="padding: 10px 12px; font-family: monospace; color: var(--text-muted);">${timeStr}</td>
            <td style="padding: 10px 12px;"><strong>${escapeHtml(r.method || 'POST')}</strong> <code style="color: #38bdf8;">${escapeHtml(r.path || '')}</code></td>
            <td style="padding: 10px 12px; color: #a78bfa;">${escapeHtml(r.requestedModel || '')}</td>
            <td style="padding: 10px 12px; color: #34d399;">${escapeHtml(r.resolvedModel || '--')}</td>
            <td style="padding: 10px 12px; color: #fbbf24; font-weight: 600;">⚡ ${r.durationMs || 0}ms</td>
            <td style="padding: 10px 12px; color: #c084fc;">${r.inputTokens || 0} / ${r.outputTokens || 0}</td>
            <td style="padding: 10px 12px;">${statusBadge}</td>
            <td style="padding: 10px 12px; text-align: right;">
                <button type="button" class="btn-ghost" style="padding: 2px 6px; font-size: 10px;" onclick="alert('Request ID: ' + ${jsStr(r.requestId || '')})">ID</button>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  // Render Debug Logs Terminal
  const debugOut = $('log-debug-output');
  if (debugOut) {
    const debugEntries = logData.debug.filter(d => {
      if (!search) return true;
      return (d.code || '').toLowerCase().includes(search) || (d.level || '').toLowerCase().includes(search);
    });

    if (debugEntries.length === 0) {
      debugOut.innerHTML = `<div style="color: var(--text-muted); padding: 12px; text-align: center;">Chưa có log debug nào.</div>`;
    } else {
      debugOut.innerHTML = debugEntries.map(d => {
        const timeStr = d.timestamp ? new Date(d.timestamp).toLocaleTimeString() : '--:--:--';
        const level = d.level || 'info';
        const levelColor = level === 'error' ? '#f87171' : level === 'warn' ? '#fbbf24' : '#34d399';
        return `
          <div style="padding: 4px 0; border-bottom: 1px dashed rgba(255,255,255,0.05); display: flex; gap: 8px;">
            <span style="color: var(--text-muted);">${timeStr}</span>
            <span style="color: ${levelColor}; font-weight: 700;">[${level.toUpperCase()}]</span>
            <span style="color: #fff;">${d.code || 'event'}</span>
            <span style="color: var(--text-muted);">${d.requestId ? `(req: ${d.requestId.slice(0, 8)}...)` : ''}</span>
          </div>
        `;
      }).join('');
    }
  }
}

function setupLogsHub() {
  const tabReq = $('tab-log-requests');
  const tabDebug = $('tab-log-debug');
  const cardsContainer = $('log-cards-container');
  const tableContainer = $('log-table-container');
  const debugContainer = $('log-debug-container');

  tabReq?.addEventListener('click', () => {
    logKind = 'request';
    tabReq.style.background = 'var(--accent)'; tabReq.style.color = '#fff'; tabReq.style.fontWeight = '600';
    tabDebug.style.background = 'transparent'; tabDebug.style.color = 'var(--text)'; tabDebug.style.fontWeight = 'normal';
    if (cardsContainer) cardsContainer.style.display = 'flex';
    if (debugContainer) debugContainer.style.display = 'none';
  });

  tabDebug?.addEventListener('click', () => {
    logKind = 'debug';
    tabDebug.style.background = 'var(--accent)'; tabDebug.style.color = '#fff'; tabDebug.style.fontWeight = '600';
    tabReq.style.background = 'transparent'; tabReq.style.color = 'var(--text)'; tabReq.style.fontWeight = 'normal';
    if (cardsContainer) cardsContainer.style.display = 'none';
    if (tableContainer) tableContainer.style.display = 'none';
    if (debugContainer) debugContainer.style.display = 'block';
  });

  $('log-filter-outcome')?.addEventListener('change', () => fetchLogs());
  $('log-filter-toolonly')?.addEventListener('change', () => fetchLogs());
  $('log-filter-toolparse')?.addEventListener('change', () => fetchLogs());
  $('log-search-input')?.addEventListener('input', () => renderLogs());
  $('btn-log-refresh')?.addEventListener('click', () => fetchLogs());

  const pauseBtn = $('btn-log-pause');
  pauseBtn?.addEventListener('click', () => {
    logPaused = !logPaused;
    if (pauseBtn) {
      pauseBtn.textContent = logPaused ? '⏸️ Đã tạm dừng' : '🟢 Tự cập nhật (2s)';
      pauseBtn.style.color = logPaused ? '#fbbf24' : '#34d399';
    }
  });

  setInterval(() => {
    if (!logPaused && !document.hidden) {
      fetchLogs();
    }
  }, 2500);
}


// ── Client config presets + key test + SSE regression + admin action log ──
window.renderClientConfig = function() {
  const preset = $('cc-preset')?.value || 'nine-router';
  const origin = window.location.origin;
  const key = sessionStorage.getItem('clickquota-api-key') || '';
  const presets = {
    'nine-router': { label: '9router (OpenAI Compatible)', base: origin + '/v1', model: 'claude-opus-5-5-CL', note: 'Trong 9router phải chọn node OpenAI Compatible, KHÔNG chọn provider OpenAI có sẵn (nó gọi api.openai.com). Base URL phải có /v1, key là key gateway.' },
    'ide-openai': { label: 'IDE / client OpenAI', base: origin + '/v1', model: 'claude-opus-5-5-CL', note: 'Client tự nối /chat/completions và /models vào base URL, nên base phải kết thúc bằng /v1.' },
    'anthropic': { label: 'Claude Code / client Anthropic', base: origin + '/v1', model: 'claude-opus-5-5-CL', note: 'Đi qua endpoint /v1/messages của gateway; base vẫn là /v1.' },
    'curl': { label: 'curl thô', base: origin + '/v1/chat/completions', model: 'claude-opus-5-5-CL', note: 'curl dùng đường dẫn đầy đủ, không dùng base URL.' },
  };
  const p = presets[preset];
  if ($('cc-base')) $('cc-base').textContent = p.base;
  if ($('cc-model')) $('cc-model').textContent = p.model;
  if ($('cc-note')) $('cc-note').textContent = p.note;
  if ($('cc-keyinfo')) $('cc-keyinfo').textContent = key ? ('Key đang dùng trong trình duyệt này: dài ' + key.length + ' ký tự, bắt đầu ' + key.slice(0, 3) + ', kết thúc ' + key.slice(-4) + ' (so sánh với key thật để phát hiện copy thiếu ký tự)') : 'Chưa nhập key vào session này (bấm Đổi key admin ở trên).';
  if ($('cc-config')) $('cc-config').textContent = 'base_url: ' + p.base + '\napi_key: <key gateway của bạn>\nmodel: ' + p.model;
};
window.copyClientConfig = async function() {
  const txt = $('cc-config')?.textContent || '';
  try { await navigator.clipboard.writeText(txt); alert('Đã copy cấu hình (key vẫn để trống — dán key thật của bạn vào).'); }
  catch { alert('Không copy được, hãy copy tay từ khung cấu hình.'); }
};
window.testClientKey = async function() {
  const key = sessionStorage.getItem('clickquota-api-key') || '';
  const out = $('cc-test-result');
  if (!key) { if (out) out.textContent = 'Chưa có key trong session.'; return; }
  try {
    const res = await fetch('/v1/models', { headers: authHeaders(), cache: 'no-store' });
    if (out) out.textContent = res.ok ? '✅ Key hợp lệ: /v1/models trả 200.' : ('❌ Key không hợp lệ hoặc base sai: HTTP ' + res.status + ' (kiểm tra lại key và base /v1).');
  } catch (e) { if (out) out.textContent = '❌ Không gọi được gateway: ' + e.message; }
};
window.runSseRegression = async function() {
  const out = $('pg-regression-result');
  if (out) out.textContent = 'Đang chạy test hồi quy...';
  try {
    const res = await fetch('/admin/api/regression/sse-toolcall', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ argLength: 600 }) });
    const data = await res.json();
    if (out) out.textContent = data.ok && data.parseOk && data.lostChars === 0
      ? ('✅ PASS: arguments ' + data.originalLength + ' ký tự ghép lại đủ ' + data.reassembledLength + ' ký tự, JSON parse được, không mất ký tự nào.')
      : ('❌ FAIL: gốc ' + data.originalLength + ' ký tự, ghép lại ' + data.reassembledLength + ' ký tự, mất ' + data.lostChars + ' ký tự, parseOk=' + data.parseOk);
  } catch (e) { if (out) out.textContent = '❌ Lỗi chạy test: ' + e.message; }
};
window.loadAdminActions = async function() {
  try {
    const res = await fetch('/admin/api/actions?limit=100', { headers: authHeaders(), cache: 'no-store' });
    const data = await res.json();
    const el = $('admin-actions-list');
    if (el) el.textContent = (data.entries || []).map(e => (e.timestamp ? new Date(e.timestamp).toLocaleString('vi-VN') : '') + ' • ' + e.action + ' • ' + (e.target || '') + ' • ' + (e.result || '')).join('\n') || 'Chưa có hành động admin nào được ghi.';
  } catch (e) { console.error('loadAdminActions error:', e); }
};

// ── Application Initialization ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const savedTab = localStorage.getItem('clickquota_active_tab') || 'dashboard';
  window.switchTab(savedTab);

  window.loadClickUpHub(false);
  window.loadKeysHub();
  setupClickUpAutoRefresh();
  setupAgentPlayground();
  window.renderClientConfig?.();
  setupLogsHub();
});
