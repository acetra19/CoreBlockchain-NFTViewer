/**
 * Static NFT viewer + JSON-RPC proxy (browser cannot call Core RPC directly — CORS).
 * Set CORE_RPC_URL in .env or environment (same as DEX / gocore HTTP).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { handleRpcBody, ipcAvailable } = require('./rpc-upstream');
const nftIpc = require('./nft-ipc');

function loadEnvFile() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    lines.forEach(function (line) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) return;
      var k = m[1];
      var v = m[2].trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    });
  } catch (e) {
    /* ignore */
  }
}
loadEnvFile();

const ROOT = path.join(__dirname, 'public');
const PORT = parseInt(process.env.NFT_VIEWER_PORT || '3470', 10);
const UPSTREAM = (process.env.CORE_RPC_URL || process.env.CORE_MAINNET_RPC_URL || '').trim();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

const ALLOW_RPC = new Set([
  'eth_call',
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_gasPrice',
  'eth_estimateGas'
]);

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const joined = path.join(ROOT, decoded);
  if (!joined.startsWith(ROOT)) return null;
  return joined;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function proxyRpc(body) {
  if (!UPSTREAM && !ipcAvailable()) throw new Error('Neither GOCORE_DATADIR (IPC) nor CORE_RPC_URL (HTTP) configured');
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    const err = new Error('Invalid JSON');
    err.code = 400;
    throw err;
  }
  const batch = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of batch) {
    if (!item || typeof item.method !== 'string' || !ALLOW_RPC.has(item.method)) {
      const err = new Error('Method not allowed');
      err.code = 403;
      throw err;
    }
  }
  return handleRpcBody(body, UPSTREAM);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;

  if (p === '/api/health') {
    send(res, 200, JSON.stringify({
      ok: true,
      ipc: ipcAvailable(),
      upstreamConfigured: !!UPSTREAM
    }), { 'Content-Type': 'application/json; charset=utf-8' });
    return;
  }

  if (p === '/api/rpc' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { status, text } = await proxyRpc(body);
      send(res, status === 200 ? 200 : 502, text, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
    } catch (e) {
      const code = e.code === 400 ? 400 : e.code === 403 ? 403 : 500;
      send(res, code, JSON.stringify({ ok: false, error: e.message }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
    }
    return;
  }

  // --- NFT API (uses xcb.contract via gocore IPC — correct CVM selectors) ---

  if (p === '/api/nft/info' && req.method === 'GET') {
    const addr = (url.searchParams.get('contract') || '').trim();
    if (!addr) { send(res, 400, JSON.stringify({ ok: false, error: 'missing contract' }), { 'Content-Type': 'application/json' }); return; }
    try {
      const name = nftIpc.getName(addr);
      const symbol = nftIpc.getSymbol(addr);
      const totalSupply = nftIpc.getTotalSupply(addr);
      send(res, 200, JSON.stringify({ ok: true, name, symbol, totalSupply }), { 'Content-Type': 'application/json' });
    } catch (e) {
      send(res, 500, JSON.stringify({ ok: false, error: e.message }), { 'Content-Type': 'application/json' });
    }
    return;
  }

  if (p === '/api/nft/tokenURI' && req.method === 'GET') {
    const addr = (url.searchParams.get('contract') || '').trim();
    const tokenId = url.searchParams.get('tokenId');
    if (!addr || tokenId == null) { send(res, 400, JSON.stringify({ ok: false, error: 'missing contract or tokenId' }), { 'Content-Type': 'application/json' }); return; }
    try {
      const uri = nftIpc.getTokenURI(addr, tokenId);
      if (uri && uri.startsWith('ERROR:')) {
        send(res, 200, JSON.stringify({ ok: false, error: uri }), { 'Content-Type': 'application/json' });
      } else {
        send(res, 200, JSON.stringify({ ok: true, tokenURI: uri }), { 'Content-Type': 'application/json' });
      }
    } catch (e) {
      send(res, 500, JSON.stringify({ ok: false, error: e.message }), { 'Content-Type': 'application/json' });
    }
    return;
  }

  if (p === '/api/nft/batch-tokenURI' && req.method === 'GET') {
    const addr = (url.searchParams.get('contract') || '').trim();
    const idsParam = (url.searchParams.get('ids') || '').trim();
    if (!addr || !idsParam) { send(res, 400, JSON.stringify({ ok: false, error: 'missing contract or ids' }), { 'Content-Type': 'application/json' }); return; }
    var ids = idsParam.split(',').map(function (s) { return parseInt(s.trim(), 10); }).filter(function (n) { return !isNaN(n); });
    if (ids.length > 50) ids = ids.slice(0, 50);
    try {
      const results = nftIpc.batchTokenURIs(addr, ids);
      send(res, 200, JSON.stringify({ ok: true, results }), { 'Content-Type': 'application/json' });
    } catch (e) {
      send(res, 500, JSON.stringify({ ok: false, error: e.message }), { 'Content-Type': 'application/json' });
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return;
  }

  let file = safePath(p === '/' ? '/index.html' : p);
  if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, 'index.html');
  }
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    file = path.join(ROOT, 'index.html');
    if (!fs.existsSync(file)) {
      send(res, 404, 'Not found');
      return;
    }
  }

  const ext = path.extname(file);
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 500, 'Error');
      return;
    }
    send(res, 200, data, { 'Content-Type': type, 'Cache-Control': 'public, max-age=120' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`NFT viewer http://127.0.0.1:${PORT} (proxy → ${UPSTREAM ? 'CORE_RPC_URL' : 'NOT SET'})`);
});
