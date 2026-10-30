import { createServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';

const config = loadConfig(process.env);
const server = createServer(config);

export default function handler(req, res) {
  server.emit('request', req, res);
}
