import { loadConfig } from './config.mjs';
import { createServer } from './server.mjs';
import { auditLogs } from './audit-logs.mjs';

let config;
try {
  config = loadConfig();
  auditLogs.debug({ code: 'config_loaded', level: 'info' });
} catch (err) {
  auditLogs.debug({ code: 'config_error', level: 'error' });
  console.error(`ClickQuota: ${err.message}`);
  process.exit(1);
}
const server = createServer(config);
server.on('error', err => {
  auditLogs.debug({ code: 'server_error', level: 'error' });
  console.error(`ClickQuota: ${err.message}`);
  process.exitCode = 1;
});
server.listen(config.port, config.host, () => {
  auditLogs.debug({ code: 'server_start', level: 'info' });
  console.log(`ClickQuota listening at http://${config.host}:${server.address().port}`);
});
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}

process.on('uncaughtException', (err) => {
  console.error('[ClickQuota] Uncaught exception:', err?.message || err);
  auditLogs.debug({ code: 'uncaught_exception', message: err?.message, level: 'error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[ClickQuota] Unhandled rejection:', reason?.message || reason);
  auditLogs.debug({ code: 'unhandled_rejection', message: reason?.message, level: 'error' });
});
