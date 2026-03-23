(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var slug = (params.get('slug') || '').trim();
  var titleEl = document.getElementById('col-title');
  var subEl = document.getElementById('col-sub');
  var gridEl = document.getElementById('nft-grid');
  var errEl = document.getElementById('col-error');
  var loadingEl = document.getElementById('col-loading');

  function showErr(msg) {
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
      errEl.className = 'msg err';
    }
    if (loadingEl) loadingEl.style.display = 'none';
  }

  function hideLoading() {
    if (loadingEl) loadingEl.style.display = 'none';
  }

  var IPFS_GATEWAYS = [
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://w3s.link/ipfs/'
  ];

  function resolveUri(uri) {
    if (!uri) return '';
    var u = String(uri).trim();
    if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7);
    return u;
  }

  function extractIpfsPath(url) {
    if (!url) return null;
    var m = /\/ipfs\/(.+)$/.exec(String(url).split('?')[0]);
    return m ? m[1] : null;
  }

  function parseDataUriJson(s) {
    var comma = s.indexOf(',');
    if (comma === -1) throw new Error('bad data URI');
    var head = s.slice(0, comma);
    var payload = s.slice(comma + 1);
    var isBase64 = /;base64/i.test(head);
    var jsonStr = isBase64 ? atob(payload) : decodeURIComponent(payload.replace(/\+/g, ' '));
    return JSON.parse(jsonStr);
  }

  function fetchJson(url) {
    return fetch(url, { mode: 'cors', cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchJsonWithGateways(firstUrl) {
    var urls = [firstUrl];
    var ipfsPath = extractIpfsPath(firstUrl);
    if (ipfsPath) {
      IPFS_GATEWAYS.forEach(function (g) {
        var u = g + ipfsPath;
        if (urls.indexOf(u) === -1) urls.push(u);
      });
    }
    var i = 0;
    function next() {
      if (i >= urls.length) return Promise.reject(new Error('metadata fetch failed'));
      return fetchJson(urls[i++]).catch(function () { return next(); });
    }
    return next();
  }

  function loadMetadata(tokenUri) {
    var s = String(tokenUri).trim();
    if (!s) return Promise.reject(new Error('empty tokenURI'));
    if (s.startsWith('{')) {
      try { return Promise.resolve(JSON.parse(s)); } catch (e) { /* fall through */ }
    }
    if (s.slice(0, 5).toLowerCase() === 'data:') {
      try { return Promise.resolve(parseDataUriJson(s)); } catch (e) { return Promise.reject(e); }
    }
    return fetchJsonWithGateways(resolveUri(s));
  }

  function pickImage(meta) {
    if (!meta || typeof meta !== 'object') return '';
    var img = meta.image || meta.image_url || meta.image_data;
    if (Array.isArray(img) && img.length) img = img[0];
    if (img && typeof img === 'object' && img !== null) img = img.src || img.href || '';
    return img ? resolveUri(String(img).trim()) : '';
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function poolLimit(items, limit, fn) {
    return new Promise(function (resolve) {
      if (!items.length) { resolve(); return; }
      var next = 0;
      var active = 0;
      function step() {
        while (active < limit && next < items.length) {
          var item = items[next++];
          active++;
          Promise.resolve(fn(item)).finally(function () {
            active--;
            if (next >= items.length && active === 0) resolve();
            else step();
          });
        }
      }
      step();
    });
  }

  // ----- Server API calls (gocore IPC, correct CVM selectors) -----

  function apiGetInfo(contractAddr) {
    return fetch('/api/nft/info?contract=' + encodeURIComponent(contractAddr))
      .then(function (r) { return r.json(); });
  }

  function apiGetTokenURI(contractAddr, tokenId) {
    return fetch('/api/nft/tokenURI?contract=' + encodeURIComponent(contractAddr) + '&tokenId=' + tokenId)
      .then(function (r) { return r.json(); });
  }

  // ----- Main -----

  function renderToken(tokenId, tokenUri, slot) {
    if (!tokenUri) {
      slot.innerHTML = '<div class="nft-thumb"><span style="padding:1rem;color:#666">#' + tokenId + '</span></div>' +
        '<div class="nft-meta">No tokenURI</div>';
      return Promise.resolve();
    }
    return loadMetadata(tokenUri)
      .then(function (meta) {
        var img = pickImage(meta);
        slot.innerHTML =
          '<div class="nft-thumb">' +
          (img ? '<img src="' + escapeAttr(img) + '" alt="" loading="lazy" />' : '<span style="padding:1rem;color:#666">No image</span>') +
          '</div>' +
          '<div class="nft-meta">#' + tokenId + (meta.name ? ' · ' + escapeHtml(String(meta.name)) : '') + '</div>';
      })
      .catch(function (err) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[NFT viewer] token', tokenId, err && err.message ? err.message : err);
        }
        slot.innerHTML = '<div class="nft-thumb"><span style="padding:1rem;color:#666">#' + tokenId + '</span></div>' +
          '<div class="nft-meta">Metadata unavailable</div>';
      });
  }

  if (!slug) {
    showErr('Missing ?slug= in URL. Go back to the home page.');
    return;
  }

  fetch('/collections.json')
    .then(function (r) {
      if (!r.ok) throw new Error('collections.json');
      return r.json();
    })
    .then(function (data) {
      var list = (data && data.collections) || [];
      var cfg = list.find(function (c) { return c.slug === slug; });
      if (!cfg) throw new Error('Unknown collection slug');
      var addr = (cfg.contractAddress || '').trim();
      if (!addr || addr.indexOf('REPLACE') === 0) {
        throw new Error('Set contractAddress for this collection in collections.json');
      }
      titleEl.textContent = cfg.name || slug;
      subEl.textContent = addr;

      return apiGetInfo(addr).then(function (info) {
        return { cfg: cfg, addr: addr, info: info };
      });
    })
    .then(function (ctx) {
      var cfg = ctx.cfg;
      var addr = ctx.addr;
      var info = ctx.info;

      if (info.ok && info.name) titleEl.textContent = info.name;

      var start = Math.max(0, parseInt(cfg.tokenIdStart, 10) || 1);
      var end;
      if (info.ok && info.totalSupply != null && info.totalSupply > 0) {
        end = start + info.totalSupply - 1;
      } else {
        end = cfg.tokenIdEnd != null ? parseInt(cfg.tokenIdEnd, 10) : NaN;
      }
      if (!Number.isFinite(end)) {
        throw new Error('Could not determine token range. Set tokenIdEnd in collections.json.');
      }

      var ids = [];
      for (var i = start; i <= end; i++) ids.push(i);

      var maxTokens = parseInt(cfg.maxTokens, 10);
      if (!Number.isFinite(maxTokens) || maxTokens < 1) maxTokens = 2000;
      if (ids.length > maxTokens) {
        showErr('Range too large (' + ids.length + '). Set "maxTokens" in collections.json.');
        return;
      }

      if (!gridEl) return;
      gridEl.innerHTML = '';
      var tasks = ids.map(function (id) {
        var slot = document.createElement('div');
        slot.className = 'card';
        slot.innerHTML = '<div class="loading" style="padding:1rem">Loading…</div>';
        gridEl.appendChild(slot);
        return { id: id, slot: slot };
      });
      hideLoading();

      var parallel = parseInt(cfg.loadParallel, 10);
      if (!Number.isFinite(parallel) || parallel < 1) parallel = 2;
      return poolLimit(tasks, parallel, function (t) {
        return apiGetTokenURI(addr, t.id)
          .then(function (resp) {
            var uri = (resp && resp.ok) ? resp.tokenURI : null;
            return renderToken(t.id, uri, t.slot);
          })
          .catch(function () {
            return renderToken(t.id, null, t.slot);
          });
      });
    })
    .catch(function (e) {
      showErr(e.message || String(e));
    });
})();
