import { auditLogs } from './audit-logs.mjs';

// Legacy upstream callers may pass prompt snippets or raw errors. Never retain them.
// Only explicit structured event codes are exposed in the persistent debug log.
export const debugLogger = {
  log(_tag, _message, level = 'info') {
    if (level === 'error') return auditLogs.debug({ code: 'upstream_error', level: 'error' });
    return null;
  },
  getLogs(options = {}) { return auditLogs.getDebug(options); },
};
