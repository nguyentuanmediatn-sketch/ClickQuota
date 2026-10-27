import net from 'node:net';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]', '::ffff:127.0.0.1']);

function blocked(host) {
  const err = new Error('NETGUARD BLOCKED: outbound connection to ' + host);
  err.code = 'ENETGUARD';
  process.stderr.write(err.message + '\n');
  return err;
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function () {
  const args = Array.prototype.slice.call(arguments);
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = first && typeof first === 'object' ? first : null;
  if (opts && opts.path) return originalConnect.apply(this, args);
  const host = opts ? (opts.host || 'localhost') : (typeof args[1] === 'string' ? args[1] : 'localhost');
  if (!LOOPBACK.has(String(host).toLowerCase())) {
    const err = blocked(host);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return originalConnect.apply(this, args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = new URL(typeof input === 'string' ? input : (input && input.url) || String(input));
  if (!LOOPBACK.has(url.hostname.toLowerCase())) throw blocked(url.hostname);
  return originalFetch(input, init);
};
