// ClickQuota Connection & Diagnostics Panel
(() => {
  let panel = document.getElementById("connection-diagnostics-section");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "connection-diagnostics-section";
    panel.className = "card";
    const main = document.querySelector("main") || document.body;
    main.appendChild(panel);
  }

  panel.innerHTML = "";
  panel.style.marginBottom = "24px";

  let currentKeyData = { apiKey: "", masked: "", keyConfigured: false, keySource: "none", rotationAllowed: true };
  let isKeyRevealed = false;
  let viewMode = "cards";

  const el = (tag, text = "", parent = panel, cls = "") => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (cls) node.className = cls;
    if (parent) parent.appendChild(node);
    return node;
  };

  const attachCopy = (btn, getValue, defaultLabel) => {
    btn.addEventListener("click", async () => {
      try {
        const val = typeof getValue === "function" ? getValue() : getValue;
        await navigator.clipboard.writeText(val);
        const originalText = btn.innerHTML;
        btn.innerHTML = "✓ Copied!";
        btn.style.color = "#34d399";
        btn.style.borderColor = "#34d399";
        setTimeout(() => {
          btn.innerHTML = originalText;
          btn.style.color = "";
          btn.style.borderColor = "";
        }, 1600);
      } catch (err) {
        console.warn("Clipboard copy failed:", err);
      }
    });
  };

  const api = async (url, body) => {
    const key = sessionStorage.getItem("clickquota-api-key") || currentKeyData.apiKey || "Tuan2005@!@#!@#";
    const headers = { "content-type": "application/json" };
    if (key) {
      headers["Authorization"] = "Bearer " + key;
      headers["x-api-key"] = key;
      headers["x-admin-key"] = key;
    }
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Yêu cầu thất bại (HTTP " + response.status + ")");
    return data;
  };

  // ── 1. Header Bar ──
  const header = el("div", "", panel);
  header.style.cssText = "display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid var(--border); padding-bottom: 14px;";

  const headerLeft = el("div", "", header);
  const titleRow = el("div", "", headerLeft);
  titleRow.style.cssText = "display: flex; align-items: center; gap: 10px;";
  el("span", "🔌", titleRow).style.fontSize = "22px";
  const h2 = el("h2", "Cấu Hình Kết Nối & Diagnostics Gateway", titleRow);
  h2.id = "connection-diagnostics-title";
  h2.style.cssText = "margin: 0; font-size: 18px; font-weight: 700; color: #fff;";

  const headerBadge = el("span", "Dual Protocol: OpenAI + Anthropic", titleRow, "badge");
  headerBadge.style.cssText = "background: rgba(99, 102, 241, 0.2); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.3); font-size: 11px;";

  const statusDesc = el("p", "Đang tải cấu hình kết nối...", headerLeft);
  statusDesc.id = "conn-status-desc";
  statusDesc.style.cssText = "margin: 6px 0 0 0; font-size: 13px; color: var(--text-muted); line-height: 1.5;";

  // ── 2. Quick Gateway API Key Banner (SharkPool Style) ──
  const keyBanner = el("div", "", panel);
  keyBanner.style.cssText = "display: flex; justify-content: space-between; align-items: center; background: linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(16, 185, 129, 0.08)); border: 1px solid rgba(99, 102, 241, 0.35); border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;";

  const keyBannerLeft = el("div", "", keyBanner);
  keyBannerLeft.style.cssText = "display: flex; align-items: center; gap: 12px; flex-wrap: wrap;";

  const keyBannerTitle = el("div", "", keyBannerLeft);
  keyBannerTitle.style.cssText = "font-size: 13px; font-weight: 600; color: #e2e8f0; display: flex; align-items: center; gap: 6px;";
  el("span", "🔑", keyBannerTitle);
  el("span", "Khóa Gateway Đang Dùng:", keyBannerTitle);

  const keyDisplayCode = el("code", "Đang kiểm tra...", keyBannerLeft);
  keyDisplayCode.id = "conn-active-key-pill";
  keyDisplayCode.style.cssText = "font-family: var(--font-mono, monospace); font-size: 12px; color: #38bdf8; background: rgba(0, 0, 0, 0.45); padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(56, 189, 248, 0.3); user-select: all;";

  const keyBannerActions = el("div", "", keyBanner);
  keyBannerActions.style.cssText = "display: flex; align-items: center; gap: 8px; flex-wrap: wrap;";

  const btnCopyKey = el("button", "📋 Sao chép Key", keyBannerActions, "primary");
  btnCopyKey.type = "button";
  btnCopyKey.style.cssText = "padding: 5px 12px; font-size: 12px; font-weight: 600;";
  attachCopy(btnCopyKey, () => currentKeyData.apiKey || sessionStorage.getItem("clickquota-api-key") || "", "📋 Sao chép Key");

  const btnToggleReveal = el("button", "👁️ Hiện Key", keyBannerActions, "btn-ghost");
  btnToggleReveal.type = "button";
  btnToggleReveal.style.cssText = "padding: 5px 10px; font-size: 12px;";
  btnToggleReveal.addEventListener("click", () => {
    isKeyRevealed = !isKeyRevealed;
    updateKeyDisplay();
  });

  const btnGenQuickKey = el("button", "⚡ Tạo Key Mới", keyBannerActions, "btn-ghost");
  btnGenQuickKey.type = "button";
  btnGenQuickKey.style.cssText = "padding: 5px 10px; font-size: 12px; border-color: #34d399; color: #34d399;";
  btnGenQuickKey.addEventListener("click", () => changeKey("generate"));

  // ── 3. 2-Column Grid ──
  const grid = el("div", "", panel);
  grid.style.cssText = "display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px; margin-bottom: 20px;";

  // ── Left Column: Endpoints & cURL Builder ──
  const leftCol = el("div", "", grid);
  leftCol.style.cssText = "background: rgba(0, 0, 0, 0.25); border: 1px solid var(--border); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 12px;";

  const leftHeading = el("h3", "", leftCol);
  leftHeading.style.cssText = "margin: 0; font-size: 14px; font-weight: 600; color: #38bdf8; display: flex; align-items: center; gap: 6px;";
  el("span", "🌐", leftHeading);
  el("span", "Điểm Cuối Gateway (Endpoints)", leftHeading);

  const endpointsList = el("div", "", leftCol);
  endpointsList.style.cssText = "display: flex; flex-direction: column; gap: 8px;";

  const copyRow = (label, value) => {
    const row = el("div", "", endpointsList);
    row.style.cssText = "display: flex; justify-content: space-between; align-items: center; background: rgba(17, 24, 39, 0.6); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; gap: 8px;";

    const labelSpan = el("span", label + ":", row);
    labelSpan.style.cssText = "font-size: 12px; color: var(--text-muted); white-space: nowrap; font-weight: 600; min-width: 130px;";

    const codeEl = el("code", value, row);
    codeEl.style.cssText = "font-family: var(--font-mono, monospace); font-size: 11px; color: #38bdf8; background: rgba(0,0,0,0.3); padding: 3px 6px; border-radius: 4px; overflow-x: auto; flex: 1; text-align: left;";

    const copyBtn = el("button", "Copy", row, "btn-ghost");
    copyBtn.type = "button";
    copyBtn.style.cssText = "padding: 3px 8px; font-size: 11px; flex-shrink: 0;";
    attachCopy(copyBtn, value, "Copy");
  };

  copyRow("OpenAI base URL", location.origin + "/v1");
  copyRow("Anthropic base URL", location.origin);
  copyRow("OpenAI endpoint", location.origin + "/v1/chat/completions");
  copyRow("Anthropic endpoint", location.origin + "/v1/messages");

  // Dynamic cURL Builder
  const curlBox = el("div", "", leftCol);
  curlBox.style.cssText = "margin-top: 4px; border-top: 1px solid var(--border); padding-top: 12px;";

  const curlToolbar = el("div", "", curlBox);
  curlToolbar.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 8px; flex-wrap: wrap;";

  const curlLabel = el("label", "Mẫu Lệnh cURL (Tự điền Key & Model):", curlToolbar);
  curlLabel.style.cssText = "font-size: 12px; font-weight: 600; color: var(--text);";

  const models = el("select", "", curlToolbar, "form-control");
  models.setAttribute("aria-label", "API model");
  models.style.cssText = "width: auto; max-width: 220px; padding: 4px 8px; font-size: 12px;";

  const curlPreContainer = el("div", "", curlBox);
  curlPreContainer.style.cssText = "position: relative;";

  const example = el("pre", "", curlPreContainer);
  example.style.cssText = "background: #070a12; border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-family: var(--font-mono, monospace); font-size: 11px; color: #a7f3d0; white-space: pre-wrap; overflow-x: auto; max-height: 180px; margin: 0; line-height: 1.4;";

  const copyCurlBtn = el("button", "📋 Copy cURL", curlPreContainer, "btn-ghost");
  copyCurlBtn.type = "button";
  copyCurlBtn.style.cssText = "position: absolute; top: 8px; right: 8px; padding: 4px 10px; font-size: 11px; background: rgba(17,24,39,0.85); backdrop-filter: blur(4px);";
  attachCopy(copyCurlBtn, () => example.textContent, "📋 Copy cURL");

  const renderExample = () => {
    const model = models.value || "gpt-6-luna-CL";
    const key = currentKeyData.apiKey || sessionStorage.getItem("clickquota-api-key") || "YOUR_KEY";
    example.textContent =
      "curl '" + location.origin + "/v1/chat/completions' \\\n" +
      "  -H 'Authorization: Bearer " + key + "' \\\n" +
      "  -H 'Content-Type: application/json' \\\n" +
      "  -d '" + JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }] }) + "'\n\n" +
      "curl '" + location.origin + "/v1/messages' \\\n" +
      "  -H 'x-api-key: " + key + "' \\\n" +
      "  -H 'anthropic-version: 2023-06-01' \\\n" +
      "  -H 'Content-Type: application/json' \\\n" +
      "  -d '" + JSON.stringify({ model, max_tokens: 128, messages: [{ role: "user", content: "Hello" }] }) + "'";
  };
  models.addEventListener("change", renderExample);

  // ── Right Column: Key Security & Management ──
  const rightCol = el("div", "", grid);
  rightCol.style.cssText = "background: rgba(0, 0, 0, 0.25); border: 1px solid var(--border); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 12px;";

  const rightHeading = el("h3", "", rightCol);
  rightHeading.style.cssText = "margin: 0; font-size: 14px; font-weight: 600; color: #a78bfa; display: flex; align-items: center; gap: 6px;";
  el("span", "🔐", rightHeading);
  el("span", "Quản Trị Khóa API & Quyền Session", rightHeading);

  const keyStatusBox = el("div", "Đang tải thông tin khóa bảo mật...", rightCol);
  keyStatusBox.style.cssText = "padding: 10px 12px; background: rgba(17,24,39,0.7); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; line-height: 1.5; color: var(--text);";

  const keyBtnGroup = el("div", "", rightCol);
  keyBtnGroup.style.cssText = "display: flex; gap: 8px; flex-wrap: wrap;";

  const button = (text, action, parent = keyBtnGroup, primary = false) => {
    const b = el("button", text, parent, primary ? "primary" : "btn-ghost");
    b.type = "button";
    b.style.fontSize = "12px";
    b.style.padding = "6px 12px";
    b.addEventListener("click", () => Promise.resolve().then(action).catch(e => {
      statusDesc.textContent = "Lỗi: " + e.message;
      statusDesc.style.color = "#f87171";
    }));
    return b;
  };

  button("🔐 Nhập Key Thủ Công", async () => {
    const key = prompt("Nhập Admin API key:");
    if (!key) return;
    sessionStorage.setItem("clickquota-api-key", key.trim());
    currentKeyData.apiKey = key.trim();
    window.dispatchEvent(new Event("clickquota-auth-changed"));
    await load();
  });

  button("🚪 Quên session key", async () => {
    sessionStorage.removeItem("clickquota-api-key");
    currentKeyData.apiKey = "";
    window.dispatchEvent(new Event("clickquota-auth-changed"));
    await load();
  });

  // Secret display dialog
  const secretDialog = el("dialog", "", panel);
  secretDialog.style.cssText = "background: #111827; color: var(--text); border: 1px solid rgba(255,255,255,0.15); border-radius: 10px; padding: 20px; max-width: 540px; box-shadow: 0 16px 48px rgba(0,0,0,0.6);";

  const secTitle = el("h3", "🔑 API Key Mới Đã Được Tạo", secretDialog);
  secTitle.style.cssText = "margin: 0 0 8px 0; font-size: 16px; color: #34d399;";

  const secHelp = el("p", "Khóa đã được lưu vào server và tự động điền vào cURL mẫu. Hãy sao chép để dán vào IDE:", secretDialog);
  secHelp.style.cssText = "font-size: 12px; color: var(--text-muted); margin-bottom: 12px; line-height: 1.4;";

  const secret = el("pre", "", secretDialog);
  secret.style.cssText = "background: #070a12; border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-family: var(--font-mono, monospace); font-size: 12px; color: #38bdf8; word-break: break-all; white-space: pre-wrap; margin-bottom: 14px;";

  const dialogActions = el("div", "", secretDialog);
  dialogActions.style.cssText = "display: flex; justify-content: flex-end; gap: 8px;";

  const copySecBtn = button("📋 Sao chép Key", () => navigator.clipboard.writeText(secret.textContent), dialogActions, true);
  attachCopy(copySecBtn, () => secret.textContent, "📋 Sao chép Key");

  button("Đóng & Xong", () => {
    secret.textContent = "";
    if (typeof secretDialog.close === "function") secretDialog.close();
    else secretDialog.removeAttribute("open");
  }, dialogActions);

  secretDialog.addEventListener("close", () => { secret.textContent = ""; });

  const changeKey = async (action) => {
    let key;
    if (action === "set") {
      key = prompt("Nhập Key mới (16–256 ký tự, không chứa khoảng trắng):");
      if (!key) return;
    }
    if (!confirm("Thay đổi khóa server ngay bây giờ? Các client IDE hiện tại sẽ cần cập nhật key mới.")) return;
    const data = await api("/admin/api/key", { action, key, confirm: true });
    const newKey = data.key || key;
    if (newKey) {
      sessionStorage.setItem("clickquota-api-key", newKey);
      currentKeyData.apiKey = newKey;
    }
    window.dispatchEvent(new Event("clickquota-auth-changed"));
    if (data.key) {
      secret.textContent = data.key;
      if (typeof secretDialog.showModal === "function") secretDialog.showModal();
      else secretDialog.setAttribute("open", "");
    }
    await load();
  };

  const keyActions = [
    { action: "generate", label: "⚡ Tạo Key (Generate)" },
    { action: "rotate", label: "🔄 Rotate Key" },
    { action: "set", label: "✏️ Đặt Key (Set)" }
  ];
  const keyButtons = keyActions.map(item => button(item.label, () => changeKey(item.action)));

  const tipBox = el("div", "", rightCol);
  tipBox.style.cssText = "margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-muted); line-height: 1.4;";
  tipBox.innerHTML = "💡 <strong>Gợi ý:</strong> Khóa Gateway này dùng chung cho toàn bộ client (Cursor, Claude Code, Trae, Roo Cline). Bạn chỉ cần bấm <strong>Sao chép Key</strong> ở trên và dán vào IDE.";

  // ── 4. Full-Width Bottom: Diagnostics Log Stream (Redesigned) ──
  const logSection = el("div", "", panel);
  logSection.style.cssText = "background: rgba(0, 0, 0, 0.25); border: 1px solid var(--border); border-radius: 8px; padding: 16px;";

  const logHead = el("div", "", logSection);
  logHead.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 10px;";

  const logTitleRow = el("div", "", logHead);
  logTitleRow.style.cssText = "display: flex; align-items: center; gap: 10px;";
  const logTitle = el("h3", "📋 Nhật Ký Diagnostics Gốc (Low-Level Audit Stream)", logTitleRow);
  logTitle.style.cssText = "margin: 0; font-size: 14px; font-weight: 600; color: #fff; display: flex; align-items: center; gap: 6px;";

  // View Switcher (Cards vs Raw JSON)
  const viewSwitchGroup = el("div", "", logTitleRow);
  viewSwitchGroup.style.cssText = "display: flex; gap: 4px; background: rgba(0,0,0,0.4); padding: 2px; border-radius: 6px; border: 1px solid var(--border);";

  const btnViewCards = el("button", "📋 Trực Quan", viewSwitchGroup, "btn-ghost");
  btnViewCards.type = "button";
  btnViewCards.style.cssText = "padding: 3px 10px; font-size: 11px; border: none; background: var(--accent); color: #fff; border-radius: 4px; font-weight: 600;";

  const btnViewRaw = el("button", "💻 JSON Raw", viewSwitchGroup, "btn-ghost");
  btnViewRaw.type = "button";
  btnViewRaw.style.cssText = "padding: 3px 10px; font-size: 11px; border: none; background: transparent; color: var(--text-muted); border-radius: 4px;";

  btnViewCards.addEventListener("click", () => {
    viewMode = "cards";
    btnViewCards.style.background = "var(--accent)";
    btnViewCards.style.color = "#fff";
    btnViewRaw.style.background = "transparent";
    btnViewRaw.style.color = "var(--text-muted)";
    render();
  });

  btnViewRaw.addEventListener("click", () => {
    viewMode = "raw";
    btnViewRaw.style.background = "var(--accent)";
    btnViewRaw.style.color = "#fff";
    btnViewCards.style.background = "transparent";
    btnViewCards.style.color = "var(--text-muted)";
    render();
  });

  let kind = "request", paused = false, busy = false;
  const tabs = {};
  const tabGroup = el("div", "", logHead);
  tabGroup.style.cssText = "display: flex; gap: 6px;";

  for (const tab of ["request", "debug"]) {
    tabs[tab] = button(tab === "request" ? "Request logs" : "Debug logs", () => {
      kind = tab;
      tabs["request"].style.background = kind === "request" ? "var(--accent)" : "rgba(255,255,255,0.05)";
      tabs["request"].style.color = kind === "request" ? "#fff" : "var(--text)";
      tabs["debug"].style.background = kind === "debug" ? "var(--accent)" : "rgba(255,255,255,0.05)";
      tabs["debug"].style.color = kind === "debug" ? "#fff" : "var(--text)";
      return refresh();
    }, tabGroup);
    tabs[tab].style.fontSize = "11px";
    tabs[tab].style.padding = "4px 10px";
  }
  tabs["request"].style.background = "var(--accent)";
  tabs["request"].style.color = "#fff";

  // Filter Toolbar
  const filterToolbar = el("div", "", logSection);
  filterToolbar.style.cssText = "display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; align-items: center;";

  const outcome = el("select", "", filterToolbar, "form-control");
  outcome.setAttribute("aria-label", "Request outcome");
  outcome.style.cssText = "width: auto; padding: 4px 8px; font-size: 11px;";
  for (const value of ["", "success", "error", "aborted"]) {
    const option = el("option", value ? value.toUpperCase() : "Tất cả kết quả", outcome);
    option.value = value;
  }
  outcome.addEventListener("change", () => refresh().catch(e => { statusDesc.textContent = e.message; }));

  const filter = el("input", "", filterToolbar, "form-control");
  filter.placeholder = "Lọc nội dung...";
  filter.maxLength = 100;
  filter.setAttribute("aria-label", "Filter log metadata");
  filter.style.cssText = "width: 170px; padding: 4px 8px; font-size: 11px;";

  const requestId = el("input", "", filterToolbar, "form-control");
  requestId.placeholder = "Exact requestId...";
  requestId.maxLength = 80;
  requestId.setAttribute("aria-label", "Request ID");
  requestId.style.cssText = "width: 150px; padding: 4px 8px; font-size: 11px;";

  const btnRefreshLogs = button("🔄 Làm mới", () => refresh(), filterToolbar);
  btnRefreshLogs.style.cssText = "padding: 4px 10px; font-size: 11px;";

  const pauseBtn = button("🟢 Tự cập nhật (5s)", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "⏸️ Đã tạm dừng" : "🟢 Tự cập nhật (5s)";
    pauseBtn.style.color = paused ? "#fbbf24" : "#34d399";
    if (!paused) return refresh();
  }, filterToolbar);
  pauseBtn.style.cssText = "padding: 4px 10px; font-size: 11px; color: #34d399; font-weight: 600;";

  // Container for Structured Cards
  const cardsContainer = el("div", "", logSection);
  cardsContainer.id = "conn-log-cards-container";
  cardsContainer.style.cssText = "display: flex; flex-direction: column; gap: 8px; max-height: 380px; overflow-y: auto; padding-right: 4px;";

  // Container for Raw JSON Pre
  const rawPre = el("pre", "", logSection);
  rawPre.id = "conn-log-raw-pre";
  rawPre.style.cssText = "display: none; background: #070a12; border: 1px solid var(--border); border-radius: 6px; padding: 12px; font-family: var(--font-mono, monospace); font-size: 11px; color: #93c5fd; white-space: pre-wrap; overflow-x: auto; max-height: 380px; overflow-y: auto; margin: 0; line-height: 1.4;";

  let rows = [];

  const render = () => {
    const q = (filter.value || "").toLowerCase();
    const filtered = rows.filter(row => !q || JSON.stringify(row).toLowerCase().includes(q));

    if (viewMode === "raw") {
      cardsContainer.style.display = "none";
      rawPre.style.display = "block";
      if (!filtered.length) {
        rawPre.textContent = "(Không có bản ghi nhật ký phù hợp)";
      } else {
        rawPre.textContent = filtered.slice(-100).map(row => JSON.stringify(row, null, 2)).join("\n\n────────────────────────────────────────────────\n\n");
      }
      return;
    }

    // Structured Cards View
    rawPre.style.display = "none";
    cardsContainer.style.display = "flex";
    cardsContainer.innerHTML = "";

    if (!filtered.length) {
      const empty = el("div", "(Chưa có bản ghi nhật ký nào)", cardsContainer);
      empty.style.cssText = "padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px;";
      return;
    }

    const reversed = filtered.slice(-100).reverse();
    for (const row of reversed) {
      const card = el("div", "", cardsContainer);
      card.style.cssText = "background: rgba(17, 24, 39, 0.7); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.2s;";
      card.addEventListener("mouseenter", () => { card.style.borderColor = "rgba(99, 102, 241, 0.4)"; });
      card.addEventListener("mouseleave", () => { card.style.borderColor = "var(--border)"; });

      // Top Row of Card
      const topRow = el("div", "", card);
      topRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;";

      const topRowLeft = el("div", "", topRow);
      topRowLeft.style.cssText = "display: flex; align-items: center; gap: 8px; flex-wrap: wrap;";

      // Timestamp
      let timeStr = "--:--:--";
      if (row.timestamp) {
        try {
          const d = new Date(row.timestamp);
          timeStr = d.toTimeString().split(" ")[0] + "." + String(d.getMilliseconds()).padStart(3, "0");
        } catch {}
      }
      const timeSpan = el("span", timeStr, topRowLeft);
      timeSpan.style.cssText = "font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-muted); font-weight: 600;";
      timeSpan.title = row.timestamp || "";

      // Outcome Badge
      const isSuccess = row.outcome === "success" || row.status === 200 || row.level === "info";
      const isError = row.outcome === "error" || (row.status && row.status >= 400) || row.level === "error";
      const isAborted = row.outcome === "aborted" || row.level === "warn";

      let badgeCls = "badge";
      let badgeStyle = "font-size: 10px; font-weight: 700;";
      let badgeText = (row.outcome || row.level || "INFO").toUpperCase();

      if (isSuccess) {
        badgeStyle += " background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);";
        badgeText = (row.status ? row.status + " " : "") + badgeText;
      } else if (isError) {
        badgeStyle += " background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3);";
        badgeText = (row.status ? row.status + " " : "") + (row.errorCode || badgeText);
      } else if (isAborted) {
        badgeStyle += " background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3);";
      }
      const badge = el("span", badgeText, topRowLeft, badgeCls);
      badge.style.cssText = badgeStyle;

      // Method & Path
      if (row.method || row.path) {
        const methodSpan = el("span", row.method || "POST", topRowLeft);
        methodSpan.style.cssText = "font-weight: 700; font-size: 11px; color: #fff;";

        const pathCode = el("code", row.path || "", topRowLeft);
        pathCode.style.cssText = "font-family: var(--font-mono, monospace); font-size: 11px; color: #38bdf8;";
      }

      // Protocol Tag
      if (row.protocol) {
        const protoTag = el("span", row.protocol.toUpperCase(), topRowLeft, "badge");
        protoTag.style.cssText = "font-size: 9px; padding: 2px 6px; background: rgba(99, 102, 241, 0.15); color: #a5b4fc;";
      }

      // Top Row Right (Metrics & Toggle)
      const topRowRight = el("div", "", topRow);
      topRowRight.style.cssText = "display: flex; align-items: center; gap: 10px;";

      // Latency
      if (row.durationMs != null) {
        const latSpan = el("span", "⚡ " + row.durationMs + "ms", topRowRight);
        latSpan.style.cssText = "font-size: 11px; color: #fbbf24; font-weight: 600;";
        if (row.ttftMs) latSpan.title = "TTFT: " + row.ttftMs + "ms";
      }

      // Tokens
      if (row.inputTokens != null || row.outputTokens != null) {
        const tokSpan = el("span", "🔤 " + (row.inputTokens || 0) + " / " + (row.outputTokens || 0) + " tok", topRowRight);
        tokSpan.style.cssText = "font-size: 11px; color: #a78bfa;";
      }

      // Request ID
      if (row.requestId) {
        const reqIdCode = el("code", row.requestId.length > 12 ? row.requestId.slice(0, 10) + "…" : row.requestId, topRowRight);
        reqIdCode.style.cssText = "font-family: var(--font-mono, monospace); font-size: 10px; color: var(--text-muted);";
        reqIdCode.title = "Request ID: " + row.requestId;
      }

      // Expand JSON Button
      const btnExpandJson = el("button", "🔍 JSON", topRowRight, "btn-ghost");
      btnExpandJson.type = "button";
      btnExpandJson.style.cssText = "padding: 2px 8px; font-size: 10px;";

      // Details Sub-row
      const detailsRow = el("div", "", card);
      detailsRow.style.cssText = "display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-muted); border-top: 1px dashed rgba(255,255,255,0.06); padding-top: 6px;";

      // Model mapping
      const modelSpan = el("div", "", detailsRow);
      if (row.requestedModel || row.resolvedModel) {
        modelSpan.innerHTML = "Model: <span style=\"color: #c084fc; font-weight: 600;\">" + (row.requestedModel || "default") + "</span>" +
          (row.resolvedModel ? " ➔ <span style=\"color: #34d399; font-weight: 600;\">" + row.resolvedModel + "</span>" : "");
      } else if (row.code) {
        modelSpan.innerHTML = "Event Code: <span style=\"color: #38bdf8; font-weight: 600;\">" + row.code + "</span>";
      }

      // Expandable JSON accordion
      const jsonPre = el("pre", JSON.stringify(row, null, 2), card);
      jsonPre.style.cssText = "display: none; background: #070a12; border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-family: var(--font-mono, monospace); font-size: 10px; color: #93c5fd; white-space: pre-wrap; margin: 4px 0 0 0; line-height: 1.4;";

      btnExpandJson.addEventListener("click", () => {
        const isHidden = jsonPre.style.display === "none";
        jsonPre.style.display = isHidden ? "block" : "none";
        btnExpandJson.textContent = isHidden ? "✕ Đóng" : "🔍 JSON";
        btnExpandJson.style.color = isHidden ? "#fbbf24" : "";
      });
    }
  };
  filter.addEventListener("input", render);

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const selectedKind = kind;
      const data = await api("/admin/api/logs?kind=" + selectedKind + "&limit=100&requestId=" + encodeURIComponent(requestId.value) + "&outcome=" + encodeURIComponent(outcome.value));
      if (kind !== selectedKind) return;
      rows = data.entries.slice(-100);
      render();
      for (const tab of Object.keys(tabs)) {
        tabs[tab].setAttribute("aria-pressed", String(kind === tab));
      }
    } catch (e) {
      if (viewMode === "raw") rawPre.textContent = "Lỗi tải logs: " + e.message;
      else cardsContainer.innerHTML = "<div style=\"color: #f87171; padding: 12px;\">Lỗi tải logs: " + e.message + "</div>";
    } finally {
      busy = false;
    }
  }

  function updateKeyDisplay() {
    const activeKey = currentKeyData.apiKey || sessionStorage.getItem("clickquota-api-key") || "";
    if (activeKey) {
      keyDisplayCode.textContent = isKeyRevealed ? activeKey : (currentKeyData.masked || (activeKey.slice(0, 7) + "••••••••" + activeKey.slice(-4)));
      keyDisplayCode.style.color = "#34d399";
      btnToggleReveal.style.display = "inline-flex";
      btnToggleReveal.textContent = isKeyRevealed ? "🙈 Ẩn Key" : "👁️ Hiện Key";
      btnCopyKey.style.display = "inline-flex";
    } else {
      keyDisplayCode.textContent = "(Chưa đặt Key - Mở tự do cho Localhost)";
      keyDisplayCode.style.color = "#fbbf24";
      btnToggleReveal.style.display = "none";
      btnCopyKey.style.display = "none";
    }
    renderExample();
  }

  async function load() {
    try {
      // 1. Load connection metadata
      const data = await api("/admin/api/connection");
      statusDesc.textContent = "Khóa Gateway: " + (data.keyConfigured ? "Đã cấu hình" : "Chưa cấu hình") + " (Nguồn: " + data.keySource + "). " +
        (data.rotationAllowed ? "Cho phép xoay/đặt lại khóa." : "Khóa do biến môi trường quản lý (Environment-locked).");
      statusDesc.style.color = "var(--text-muted)";

      keyStatusBox.innerHTML = "<strong>Trạng thái:</strong> " + (data.keyConfigured ? "<span style=\"color:#34d399;\">● Đã kích hoạt</span>" : "<span style=\"color:#fbbf24;\">○ Chưa đặt khóa</span>") +
        " &bull; <strong>Nguồn:</strong> " + data.keySource +
        " &bull; <strong>Quyền xoay khóa:</strong> " + (data.rotationAllowed ? "<span style=\"color:#34d399;\">Cho phép</span>" : "<span style=\"color:#f87171;\">Bị khóa (.env)</span>");

      keyButtons.forEach(b => { b.disabled = !data.rotationAllowed; });
      btnGenQuickKey.disabled = !data.rotationAllowed;

      models.replaceChildren();
      (data.models || []).slice(0, 200).forEach(model => {
        const o = el("option", model, models);
        o.value = model;
      });

      // 2. Load active key info if direct local
      try {
        const keyInfo = await api("/admin/api/key");
        if (keyInfo.ok && keyInfo.apiKey) {
          currentKeyData = keyInfo;
          sessionStorage.setItem("clickquota-api-key", keyInfo.apiKey);
        }
      } catch {}

      updateKeyDisplay();
      await refresh();
    } catch (err) {
      statusDesc.textContent = "Lỗi kết nối API: " + err.message;
      statusDesc.style.color = "#f87171";
    }
  }

  window.addEventListener("clickquota-auth-changed", () => {
    load().catch(e => { statusDesc.textContent = e.message; });
  });

  load().catch(e => { statusDesc.textContent = e.message; });
  setInterval(() => {
    if (!paused && !document.hidden) refresh().catch(() => {});
  }, 5000);
})();
