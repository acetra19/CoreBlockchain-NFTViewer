/**
 * NFT read-only queries via gocore IPC: xcb.contract(abi).at(address).method().
 * CVM uses different function selectors than EVM, so ethers.js in the browser cannot
 * encode calls correctly. This module does it server-side, same pattern as my-memecoin/gui/dex-handler.js.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const GOCORE_DATADIR = (process.env.GOCORE_DATADIR || '').trim();
const TMP_SCRIPT = path.join(__dirname, '_nft_ipc_tmp.js');

function getIpcPath() {
  if (process.platform === 'win32') return '\\\\.\\pipe\\gocore.ipc';
  const d = GOCORE_DATADIR;
  const sub = path.join(d, 'gocore', 'gocore.ipc');
  const root = path.join(d, 'gocore.ipc');
  if (fs.existsSync(sub)) return sub;
  return root;
}

function runScript(jsCode) {
  if (!GOCORE_DATADIR) throw new Error('GOCORE_DATADIR not set');
  const ipcPath = getIpcPath();
  fs.writeFileSync(TMP_SCRIPT, jsCode.trim(), 'utf8');
  const scriptForLoad = TMP_SCRIPT.replace(/\\/g, '/');
  const result = spawnSync('gocore', [
    '--datadir', GOCORE_DATADIR,
    'attach', ipcPath,
    '--exec', "loadScript('" + scriptForLoad + "')"
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
  const stdout = result.stdout || '';
  const m = stdout.match(/RESULT:(.+)/);
  if (m) return m[1].trim();
  if (result.status !== 0) {
    const err = (stdout + (result.stderr || '')).trim();
    throw new Error(err.slice(0, 300) || 'gocore script failed');
  }
  return stdout.trim();
}

const ERC721_ABI = JSON.stringify([
  {"constant":true,"inputs":[],"name":"name","outputs":[{"name":"","type":"string"}],"type":"function"},
  {"constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"","type":"string"}],"type":"function"},
  {"constant":true,"inputs":[],"name":"totalSupply","outputs":[{"name":"","type":"uint256"}],"type":"function"},
  {"constant":true,"inputs":[{"name":"tokenId","type":"uint256"}],"name":"tokenURI","outputs":[{"name":"","type":"string"}],"type":"function"},
  {"constant":true,"inputs":[{"name":"tokenId","type":"uint256"}],"name":"ownerOf","outputs":[{"name":"","type":"address"}],"type":"function"}
]);

function getName(contractAddr) {
  return runScript(`
var c = xcb.contract(${ERC721_ABI}).at("${contractAddr}");
try { console.log("RESULT:" + c.name()); } catch(e) { console.log("RESULT:"); }
`);
}

function getSymbol(contractAddr) {
  return runScript(`
var c = xcb.contract(${ERC721_ABI}).at("${contractAddr}");
try { console.log("RESULT:" + c.symbol()); } catch(e) { console.log("RESULT:"); }
`);
}

function getTotalSupply(contractAddr) {
  var raw = runScript(`
var c = xcb.contract(${ERC721_ABI}).at("${contractAddr}");
try {
  var s = c.totalSupply();
  if (s && typeof s.toString === 'function') s = s.toString(10);
  console.log("RESULT:" + s);
} catch(e) { console.log("RESULT:ERROR:" + e.message); }
`);
  if (raw.startsWith('ERROR:')) return null;
  var n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

function getTokenURI(contractAddr, tokenId) {
  return runScript(`
var c = xcb.contract(${ERC721_ABI}).at("${contractAddr}");
try { console.log("RESULT:" + c.tokenURI(${parseInt(tokenId, 10)})); } catch(e) { console.log("RESULT:ERROR:" + e.message); }
`);
}

function batchTokenURIs(contractAddr, tokenIds) {
  var idsJs = JSON.stringify(tokenIds.map(function (id) { return parseInt(id, 10); }));
  var raw = runScript(`
var c = xcb.contract(${ERC721_ABI}).at("${contractAddr}");
var ids = ${idsJs};
var out = [];
for (var i = 0; i < ids.length; i++) {
  try {
    var u = c.tokenURI(ids[i]);
    out.push(ids[i] + "\\t" + (u || ""));
  } catch(e) {
    out.push(ids[i] + "\\tERROR:" + e.message);
  }
}
console.log("RESULT:" + out.join("\\n"));
`);
  var results = {};
  raw.split('\n').forEach(function (line) {
    var tab = line.indexOf('\t');
    if (tab === -1) return;
    var id = parseInt(line.slice(0, tab), 10);
    var uri = line.slice(tab + 1);
    results[id] = uri.startsWith('ERROR:') ? null : uri;
  });
  return results;
}

module.exports = { getName, getSymbol, getTotalSupply, getTokenURI, batchTokenURIs };
