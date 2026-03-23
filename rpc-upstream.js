/**
 * JSON-RPC proxy via gocore IPC (attach --exec), same approach as my-memecoin/gui/dex-handler.js.
 * No HTTP port needed on gocore.
 * Falls back to HTTP if CORE_RPC_URL is set (e.g. remote node).
 */
const { spawnSync } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const GOCORE_DATADIR = (process.env.GOCORE_DATADIR || '').trim();

function getGocoreIpcPath(datadir) {
  if (process.platform === 'win32') return '\\\\.\\pipe\\gocore.ipc';
  const d = datadir || '';
  const inSubdir = path.join(d, 'gocore', 'gocore.ipc');
  const inRoot = path.join(d, 'gocore.ipc');
  if (fs.existsSync(inSubdir)) return inSubdir;
  return inRoot;
}

function ipcAvailable() {
  if (!GOCORE_DATADIR) return false;
  const p = getGocoreIpcPath(GOCORE_DATADIR);
  return fs.existsSync(p);
}

/**
 * Run a JS expression via `gocore attach --exec` and return stdout.
 */
function gocoreExec(jsExpr) {
  const ipcPath = getGocoreIpcPath(GOCORE_DATADIR);
  const result = spawnSync('gocore', [
    '--datadir', GOCORE_DATADIR,
    'attach', ipcPath,
    '--exec', jsExpr
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  const out = ((result.stdout || '') + (result.stderr || '')).trim();
  if (result.status !== 0 && !out) {
    throw new Error('gocore attach failed (exit ' + result.status + ')');
  }
  return out;
}

/**
 * Handle a single JSON-RPC request object via IPC.
 * Returns the JSON-RPC response object.
 */
function handleViaIpc(req) {
  const id = req.id != null ? req.id : null;
  const method = req.method;

  if (method === 'eth_chainId' || method === 'xcb_chainId') {
    var raw = gocoreExec('xcb.chainId');
    var cleaned = raw.replace(/[\s"]/g, '');
    if (!/^0x/i.test(cleaned)) cleaned = '0x' + parseInt(cleaned, 10).toString(16);
    return { jsonrpc: '2.0', id: id, result: cleaned };
  }

  if (method === 'eth_blockNumber' || method === 'xcb_blockNumber') {
    var raw2 = gocoreExec('xcb.blockNumber');
    var num = parseInt(raw2.replace(/[\s"]/g, ''), 10);
    return { jsonrpc: '2.0', id: id, result: '0x' + num.toString(16) };
  }

  if (method === 'eth_call' || method === 'xcb_call') {
    var params = req.params || [];
    var callObj = params[0] || {};
    var block = params[1] || 'latest';
    var to = (callObj.to || '').trim();
    var data = (callObj.data || '').trim();
    var gas = callObj.gas || '0xfffff';
    var jsObj = '{to:"' + to + '",data:"' + data + '",gas:"' + gas + '"}';
    var blockArg = typeof block === 'string' ? '"' + block + '"' : String(block);
    var expr = 'xcb.call(' + jsObj + ',' + blockArg + ')';
    var raw3 = gocoreExec(expr);
    var result = raw3.replace(/[\s"]/g, '');
    if (!result.startsWith('0x') && /^[0-9a-fA-F]+$/.test(result)) result = '0x' + result;
    return { jsonrpc: '2.0', id: id, result: result };
  }

  if (method === 'eth_gasPrice' || method === 'xcb_gasPrice') {
    var raw4 = gocoreExec('xcb.gasPrice');
    var gp = raw4.replace(/[\s"]/g, '');
    if (!/^0x/i.test(gp)) gp = '0x' + parseInt(gp, 10).toString(16);
    return { jsonrpc: '2.0', id: id, result: gp };
  }

  return { jsonrpc: '2.0', id: id, error: { code: -32601, message: 'Method not supported via IPC proxy' } };
}

// ---- HTTP fallback (when CORE_RPC_URL is set and IPC is not available) ----

var httpPermits = 4;
var httpWaiters = [];

function httpAcquire() {
  return new Promise(function (resolve) {
    if (httpPermits > 0) { httpPermits--; resolve(); }
    else httpWaiters.push(resolve);
  });
}

function httpRelease() {
  if (httpWaiters.length > 0) httpWaiters.shift()();
  else httpPermits++;
}

function postJsonOnce(urlStr, bodyString) {
  return new Promise(function (resolve, reject) {
    var u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('Invalid CORE_RPC_URL')); return; }
    var lib = u.protocol === 'https:' ? https : http;
    var opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyString, 'utf8'),
        Connection: 'close'
      },
      timeout: 120000
    };
    var req = lib.request(opts, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(); reject(new Error('Upstream timeout')); });
    req.write(bodyString);
    req.end();
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function postWithRetryHttp(urlStr, bodyString) {
  await httpAcquire();
  var retries = 3;
  var lastErr;
  try {
    for (var attempt = 0; attempt <= retries; attempt++) {
      try {
        return await postJsonOnce(urlStr, bodyString);
      } catch (e) {
        lastErr = e;
        var code = e && e.code;
        var retryable = code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EPIPE';
        if (!retryable) throw e;
        if (attempt >= retries) break;
        await sleep(80 * (attempt + 1));
      }
    }
    throw new Error('Upstream: ' + ((lastErr && lastErr.message) || 'unknown') + ' (after retries)');
  } finally {
    httpRelease();
  }
}

// ---- Public API ----

/**
 * Process a JSON-RPC body string and return { status, text }.
 * Uses IPC if GOCORE_DATADIR is set, otherwise falls back to CORE_RPC_URL (HTTP).
 */
async function handleRpcBody(bodyString, upstreamUrl) {
  var parsed;
  try {
    parsed = JSON.parse(bodyString);
  } catch (e) {
    return { status: 400, text: JSON.stringify({ ok: false, error: 'Invalid JSON' }) };
  }

  if (ipcAvailable()) {
    try {
      if (Array.isArray(parsed)) {
        var results = parsed.map(function (req) { return handleViaIpc(req); });
        return { status: 200, text: JSON.stringify(results) };
      }
      var result = handleViaIpc(parsed);
      return { status: 200, text: JSON.stringify(result) };
    } catch (e) {
      return { status: 500, text: JSON.stringify({ jsonrpc: '2.0', id: parsed.id || null, error: { code: -32000, message: e.message || 'IPC error' } }) };
    }
  }

  if (upstreamUrl) {
    return postWithRetryHttp(upstreamUrl, bodyString);
  }

  return { status: 500, text: JSON.stringify({ ok: false, error: 'Neither GOCORE_DATADIR (IPC) nor CORE_RPC_URL (HTTP) configured' }) };
}

module.exports = { handleRpcBody, ipcAvailable };
