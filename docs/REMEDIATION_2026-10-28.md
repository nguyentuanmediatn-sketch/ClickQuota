# CLICKQUOTA — HỒ SƠ REMEDIATION P1→P3 (2026-10-28)

Trạng thái: **HOÀN TẤT — GO** (thẩm định độc lập 3 lượt). Kiểm chứng cuối: `FOCUS_OK tests=67 pass=67 fail=0` + `NO_NEW_FAILURES tests=140 pass=140 fail=0` + `SMOKE_OK` (SOP runner cách ly, net-guard, state rỗng).

## P1 (6/6 đã vá)

| # | Fix | Vị trí |
|---|---|---|
| 1 | Mật khẩu master hardcode → env `CLICKQUOTA_MASTER_PASSWORD` (timing-safe, rỗng = tắt path); client bỏ literal/seed/default; `masterAuthEnabled` thay `masterAdmin`; GET key/keys masked-only; `mintedToken` vào SECRET_FIELDS; toggle trả masked | `key-store.mjs`, `server.mjs`, `admin.js`, `connection.js`, `index.html` |
| 2 | Role escalation: `adminAuthorized` chỉ nhận role `admin`/gateway key/master | `server.mjs:59-69` |
| 3 | Prose→tool-call chặn 3 lớp: parser null khi 0 tool; mapper drop tên ngoài catalog (bỏ fallback `resolveIdealName/rawName`); bare-JSON cần ≥70% dominance | `upstream.mjs:383-388`, `tools.mjs:125-131`, `text-fallback.mjs:362-376` |
| 4 | `upstreamRes.on('error', reject)` — hết crash process khi response upstream hỏng | `upstream.mjs:655` |
| 5 | Auto-Recreate chỉ chạy khi quota fresh (<30 phút) + 0 audit failure, chặn ở CẢ HAI call site | `pool.mjs:1665-1688, 2065-2093` |
| 6 | Test mới: SAFETY10-13 + `test/auto-recreate-guard.test.mjs` (stale/fresh/empty) | `test/` |

## P2 (11/11 đã vá)

responseHistory cap 256KiB/entry + LRU refresh (256×256KiB ≈ 128MiB ceiling); `serializeMessageContent` object→JSON (hết `[object Object]`); pool dùng store canonical `config.mjs` (corrupt → throw, không bao giờ ghi đè state thật); mint token serialize per-account (mutex chuỗi promise — live-probe 3 mint song song tuần tự, token riêng từng ws); audit chỉ xóa cooldown vì-quota (giữ Model-bị-khóa 24h / Rate-Limit / Breaker); `jsStr = escapeHtml(JSON.stringify())` toàn bộ onclick (probe 10 vector attack — không vector nào thoát); `recordKeyUsage` chạy SAU handler (tokenLimit hoạt động); strip `<think>` + `<thinking>` chưa đóng; Muse key env-only (không default); `admin.test` mock base loopback; FIFO→LRU.

## P3 (đã vá toàn bộ mục actionable)

Gate focus động (fail=0, pass=tests, tests≥45); reset fallback 00:00 UTC (07:00 VN) + snapshot/admin/placeholder hiển thị đúng; persist cooldown Rate-Limit/Breaker; zombie team 404/410 coi như đã xóa; recheck cooldown sau khi chờ queue (fail-fast POOL_EXHAUSTED); renewal mở khóa `quotaStatus`; bỏ header `x-proxy-workspace` (2 nơi); README cập nhật 6+ chỗ (responses hỗ trợ, GET key masked, master password env, muse endpoints, auto-recreate guard); SAFE_CODES thêm `uncaught_exception`/`unhandled_rejection`; `ttftMs` wire cả stream lẫn non-stream; `?? {}` guard đầy đủ; guard `</system-reminder>` mồ côi; title-sniff chỉ system; RangeError → message trung tính; Muse abort early-return + fetch try/catch; preview lỗi completion chỉ log shape; intent xác nhận EXACT (bỏ heuristic prefix); profile pentagi; `.env.example` placeholder MUSE_API_KEY; escape table-view logs.

## Vị trí khôi phục

Backup toàn bộ file trước khi sửa: `scratch/pre-fix-backup-20261028/` (thiếu 2 file chỉ sửa comment/profile: `protocols/openai-responses.mjs`, `ide-detect.mjs` — khả năng hoàn nguyên không bị ảnh hưởng nhờ git).

## Việc còn mở (quyết định của owner)

1. **Rotate secret trong `.env`** (không sửa tự động): `CLICKQUOTA_API_KEY` vẫn là mật khẩu cũ đã rò rỉ trong source trước đây; `MUSE_API_KEY` là key test mặc định. Rotate rồi restart.
2. **Restart server production** để nhận code mới (IDE client tự reconnect; backup state trước khi kill theo SOP).
3. Commit working tree (8 file sửa từ trước + các file sửa/remediating này) để chốt điểm rollback.
