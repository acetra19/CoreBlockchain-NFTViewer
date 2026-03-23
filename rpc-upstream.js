/**
 * Reliable JSON-RPC POST to gocore (avoids undici fetch issues to localhost under load).
 */
const http = require('http');
const https = require('https');

const MAX_CONCURRENT = parseInt(process.env.RPC_UPSTREAM_MAX_CONCURRENT || '4', 10);
var permits = MAX_CONCURRENT;
var waiters = [];

function acquireSemaphore() {
  return new Promise(function (resolve) {
    if (permits > 0) {
      permits--;
      resolve();
    } else {
      waiters.push(resolve);
    }
  });
}

function releaseSemaphore() {
  if (waiters.length > 0) {
    var w = waiters.shift();
    w();
  } else {
    permits++;
  }
}

function postJsonOnce(urlStr, bodyString) {
  return new Promise(function (resolve, reject) {
    var u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error('Invalid CORE_RPC_URL'));
      return;
    }
    var lib = u.protocol === 'https:' ? https : http;
    var port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    var pathName = u.pathname || '/';
    var search = u.search || '';
    var opts = {
      hostname: u.hostname,
      port: port,
      path: pathName + search,
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
        resolve({
          status: res.statusCode || 0,
          text: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    req.on('error', function (err) {
      reject(err);
    });
    req.on('timeout', function () {
      req.destroy();
      reject(new Error('Upstream timeout'));
    });
    req.write(bodyString);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/**
 * POST body to upstream with retries and concurrency limit.
 */
async function postWithRetry(urlStr, bodyString) {
  await acquireSemaphore();
  var retries = parseInt(process.env.RPC_UPSTREAM_RETRIES || '3', 10);
  var lastErr;
  try {
    for (var attempt = 0; attempt <= retries; attempt++) {
      try {
        return await postJsonOnce(urlStr, bodyString);
      } catch (e) {
        lastErr = e;
        var msg = (e && e.message) || String(e);
        var code = e && e.code;
        var retryable =
          code === 'ECONNRESET' ||
          code === 'ECONNREFUSED' ||
          code === 'ETIMEDOUT' ||
          code === 'EPIPE' ||
          msg.indexOf('timeout') !== -1;
        if (!retryable) throw e;
        if (attempt >= retries) break;
        await sleep(80 * (attempt + 1));
      }
    }
    var detail = lastErr && (lastErr.code || lastErr.message) ? String(lastErr.code || lastErr.message) : 'unknown';
    throw new Error('Upstream RPC: ' + detail + ' (after retries)');
  } finally {
    releaseSemaphore();
  }
}

module.exports = { postWithRetry, MAX_CONCURRENT };
