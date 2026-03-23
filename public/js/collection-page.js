(function () {
  'use strict';

  var ERC721_ABI = [
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function uri(uint256 tokenId) view returns (string)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)'
  ];

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

  function resolveTokenUri(uri) {
    if (!uri) return '';
    var u = String(uri).trim();
    if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7);
    return u;
  }

  /** Path after /ipfs/ (CID + optional subpath), or null */
  function extractIpfsPath(url) {
    if (!url) return null;
    var clean = String(url).split('?')[0];
    var m = /\/ipfs\/(.+)$/.exec(clean);
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

  /** Some nodes return tokenURI as hex-encoded UTF-8 bytes. */
  function tryDecodeHexUtf8(s) {
    if (typeof s !== 'string' || !/^0x[0-9a-f]+$/i.test(s) || s.length < 4) return null;
    try {
      if (typeof ethers !== 'undefined' && ethers.getBytes) {
        var bytes = ethers.getBytes(s);
        if (!bytes.length) return null;
        return new TextDecoder().decode(bytes);
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  /** Try same JSON over multiple IPFS gateways if the first request fails. */
  function fetchJsonWithGateways(firstUrl) {
    var urls = [firstUrl];
    var path = extractIpfsPath(firstUrl);
    if (path) {
      IPFS_GATEWAYS.forEach(function (g) {
        var u = g + path;
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

  /** Resolve metadata object from tokenURI string (HTTP, ipfs, or data: JSON). */
  function loadMetadataFromTokenUri(uri) {
    var s = String(uri).trim();
    var fromHex = tryDecodeHexUtf8(s);
    if (fromHex) s = fromHex.trim();
    if (!s) return Promise.reject(new Error('empty tokenURI'));
    if (s.startsWith('{')) {
      try {
        return Promise.resolve(JSON.parse(s));
      } catch (e) {
        /* fall through */
      }
    }
    if (s.slice(0, 5).toLowerCase() === 'data:') {
      try {
        return Promise.resolve(parseDataUriJson(s));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return fetchJsonWithGateways(resolveTokenUri(s));
  }

  function pickImage(meta) {
    if (!meta || typeof meta !== 'object') return '';
    var img = meta.image || meta.image_url || meta.image_data;
    if (Array.isArray(img) && img.length) img = img[0];
    if (img && typeof img === 'object' && img !== null) {
      img = img.src || img.href || '';
    }
    return img ? String(img).trim() : '';
  }

  /** Resolve relative image paths against the metadata document URL (HTTP/IPFS). */
  function resolveImageUrl(raw, tokenUriStr) {
    if (!raw) return '';
    var r = String(raw).trim();
    if (r.startsWith('data:')) return r;
    if (r.startsWith('ipfs://')) return resolveTokenUri(r);
    if (/^https?:\/\//i.test(r)) return r;
    var baseStr = String(tokenUriStr || '').trim();
    if (!baseStr || baseStr.startsWith('data:') || baseStr.startsWith('{')) return resolveTokenUri(r);
    try {
      var base = resolveTokenUri(baseStr);
      if (base.indexOf('://') !== -1) return new URL(r, base).href;
    } catch (e) {
      /* ignore */
    }
    return resolveTokenUri(r);
  }

  function provider() {
    var base = window.location.origin || '';
    return new ethers.JsonRpcProvider(base + '/api/rpc');
  }

  function range(cfg, contract) {
    var start = Math.max(0, parseInt(cfg.tokenIdStart, 10) || 1);
    var endCfg = cfg.tokenIdEnd != null ? parseInt(cfg.tokenIdEnd, 10) : NaN;
    if (cfg.tryTotalSupply && contract) {
      return contract.totalSupply()
        .then(function (n) {
          var count = Number(n);
          if (!Number.isFinite(count) || count <= 0) return fallbackRange(start, endCfg);
          var end = start + count - 1;
          return { start: start, end: Math.min(end, start + 100000) };
        })
        .catch(function () {
          return fallbackRange(start, endCfg);
        });
    }
    return Promise.resolve(fallbackRange(start, endCfg));
  }

  function fallbackRange(start, endCfg) {
    if (!Number.isFinite(endCfg)) {
      throw new Error('Set tokenIdEnd in collections.json or enable tryTotalSupply.');
    }
    return { start: start, end: endCfg };
  }

  function readTokenUri(contract, tokenId) {
    return contract.tokenURI(tokenId).catch(function () {
      return contract.uri(tokenId);
    });
  }

  /** @returns {Promise<void>} */
  function loadOne(contract, tokenId, slot) {
    return readTokenUri(contract, tokenId)
      .then(function (uri) {
        return loadMetadataFromTokenUri(uri).then(function (meta) {
          return { meta: meta, tokenUri: uri };
        });
      })
      .then(function (pack) {
        var meta = pack.meta;
        var tokenUri = pack.tokenUri;
        var rawImg = pickImage(meta);
        var img = resolveImageUrl(rawImg, String(tokenUri));
        slot.innerHTML =
          '<div class="nft-thumb">' +
          (img ? '<img src="' + escapeAttr(img) + '" alt="" loading="lazy" />' : '<span style="padding:1rem;color:#666">No image</span>') +
          '</div>' +
          '<div class="nft-meta">#' + String(tokenId) + (meta.name ? ' · ' + escapeHtml(String(meta.name)) : '') + '</div>';
      })
      .catch(function (err) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[NFT viewer] token', tokenId, err && err.message ? err.message : err);
        }
        slot.innerHTML = '<div class="nft-thumb"><span style="padding:1rem;color:#666">#' + tokenId + '</span></div>' +
          '<div class="nft-meta">Metadata unavailable</div>';
      });
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /** Run async tasks with at most `limit` concurrent executions. */
  function poolLimit(items, limit, fn) {
    return new Promise(function (resolve) {
      if (!items.length) {
        resolve();
        return;
      }
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
      var c = new ethers.Contract(addr, ERC721_ABI, provider());
      return range(cfg, c).then(function (rng) {
        return { cfg: cfg, contract: c, rng: rng };
      });
    })
    .then(function (ctx) {
      var c = ctx.contract;
      var rng = ctx.rng;
      return c.name()
        .then(function (n) {
          if (n && titleEl) titleEl.textContent = n;
          return ctx;
        })
        .catch(function () { return ctx; });
    })
    .then(function (ctx) {
      var c = ctx.contract;
      var cfg = ctx.cfg;
      var rng = ctx.rng;
      var ids = [];
      var i;
      for (i = rng.start; i <= rng.end; i++) ids.push(i);
      var maxTokens = parseInt(cfg.maxTokens, 10);
      if (!Number.isFinite(maxTokens) || maxTokens < 1) maxTokens = 2000;
      if (ids.length > maxTokens) {
        showErr('Range too large (' + ids.length + '). Set "maxTokens" in collections.json (e.g. 2500) or narrow tokenIdEnd.');
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
      if (!Number.isFinite(parallel) || parallel < 1) parallel = 8;
      return poolLimit(tasks, parallel, function (t) {
        return loadOne(c, t.id, t.slot);
      });
    })
    .catch(function (e) {
      showErr(e.message || String(e));
    });
})();
