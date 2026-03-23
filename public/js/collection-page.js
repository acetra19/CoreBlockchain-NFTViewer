(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var slug = (params.get('slug') || '').trim();
  var titleEl = document.getElementById('col-title');
  var subEl = document.getElementById('col-sub');
  var statsEl = document.getElementById('col-stats');
  var gridEl = document.getElementById('nft-grid');
  var errEl = document.getElementById('col-error');
  var loadingEl = document.getElementById('col-loading');

  var modalOverlay = document.getElementById('nftModal');
  var modalImg = document.getElementById('modalImg');
  var modalId = document.getElementById('modalId');
  var modalName = document.getElementById('modalName');
  var modalDesc = document.getElementById('modalDesc');
  var modalTraits = document.getElementById('modalTraits');
  var modalClose = document.getElementById('modalClose');

  var tokenMetaCache = {};

  function showErr(msg) {
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
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
    return fetch(url, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchJsonGateways(firstUrl) {
    var urls = [firstUrl];
    var p = extractIpfsPath(firstUrl);
    if (p) IPFS_GATEWAYS.forEach(function (g) { var u = g + p; if (urls.indexOf(u) === -1) urls.push(u); });
    var i = 0;
    function next() {
      if (i >= urls.length) return Promise.reject(new Error('fetch failed'));
      return fetchJson(urls[i++]).catch(function () { return next(); });
    }
    return next();
  }

  function loadMetadata(tokenUri) {
    var s = String(tokenUri).trim();
    if (!s) return Promise.reject(new Error('empty'));
    if (s.startsWith('{')) { try { return Promise.resolve(JSON.parse(s)); } catch (e) { /* */ } }
    if (s.slice(0, 5).toLowerCase() === 'data:') {
      try { return Promise.resolve(parseDataUriJson(s)); } catch (e) { return Promise.reject(e); }
    }
    return fetchJsonGateways(resolveUri(s));
  }

  function pickImage(meta) {
    if (!meta || typeof meta !== 'object') return '';
    var img = meta.image || meta.image_url || meta.image_data;
    if (Array.isArray(img) && img.length) img = img[0];
    if (img && typeof img === 'object') img = img.src || img.href || '';
    return img ? resolveUri(String(img).trim()) : '';
  }

  function escapeHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  function poolLimit(items, limit, fn) {
    return new Promise(function (resolve) {
      if (!items.length) { resolve(); return; }
      var next = 0, active = 0;
      function step() {
        while (active < limit && next < items.length) {
          var item = items[next++];
          active++;
          Promise.resolve(fn(item)).finally(function () {
            active--;
            if (next >= items.length && active === 0) resolve(); else step();
          });
        }
      }
      step();
    });
  }

  // ----- Server API -----

  function apiGetInfo(addr) {
    return fetch('/api/nft/info?contract=' + encodeURIComponent(addr)).then(function (r) { return r.json(); });
  }

  function apiGetTokenURI(addr, tokenId) {
    return fetch('/api/nft/tokenURI?contract=' + encodeURIComponent(addr) + '&tokenId=' + tokenId).then(function (r) { return r.json(); });
  }

  // ----- Modal -----

  function openModal(tokenId) {
    var data = tokenMetaCache[tokenId];
    if (!data) return;
    var meta = data.meta;
    var img = data.img;

    modalImg.innerHTML = img
      ? '<img src="' + escapeAttr(img) + '" alt="" style="image-rendering:pixelated;" />'
      : '<div style="padding:3rem;color:var(--muted);text-align:center;">No image</div>';
    modalId.textContent = '#' + tokenId;
    modalName.textContent = (meta && meta.name) ? String(meta.name) : 'Token #' + tokenId;
    modalDesc.textContent = (meta && meta.description) ? String(meta.description) : '';
    modalDesc.style.display = (meta && meta.description) ? 'block' : 'none';

    modalTraits.innerHTML = '';
    var attrs = (meta && meta.attributes) || [];
    if (Array.isArray(attrs) && attrs.length) {
      attrs.forEach(function (a) {
        if (!a || !a.trait_type) return;
        var card = document.createElement('div');
        card.className = 'trait-card';
        card.innerHTML =
          '<div class="trait-type">' + escapeHtml(String(a.trait_type)) + '</div>' +
          '<div class="trait-value">' + escapeHtml(String(a.value != null ? a.value : '—')) + '</div>';
        modalTraits.appendChild(card);
      });
    } else {
      modalTraits.innerHTML = '<div style="grid-column:1/-1;color:var(--muted);font-size:0.8rem;text-align:center;padding:0.5rem;">No traits found</div>';
    }

    modalOverlay.style.display = 'flex';
    requestAnimationFrame(function () { modalOverlay.classList.add('open'); });
  }

  function closeModal() {
    modalOverlay.classList.remove('open');
    setTimeout(function () { modalOverlay.style.display = 'none'; }, 250);
  }

  if (modalClose) modalClose.addEventListener('click', closeModal);
  if (modalOverlay) modalOverlay.addEventListener('click', function (e) {
    if (e.target === modalOverlay) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modalOverlay && modalOverlay.classList.contains('open')) closeModal();
  });

  // ----- Render -----

  function renderToken(tokenId, tokenUri, slot, delay) {
    if (!tokenUri) {
      slot.innerHTML = '<div class="nft-thumb"><span style="padding:1rem;color:var(--muted)">#' + tokenId + '</span></div>' +
        '<div class="nft-meta"><span class="token-id">#' + tokenId + '</span></div>';
      slot.classList.add('loaded');
      slot.style.animationDelay = delay + 'ms';
      return Promise.resolve();
    }
    return loadMetadata(tokenUri)
      .then(function (meta) {
        var img = pickImage(meta);
        tokenMetaCache[tokenId] = { meta: meta, img: img };
        slot.innerHTML =
          '<div class="nft-thumb">' +
          (img ? '<img src="' + escapeAttr(img) + '" alt="" loading="lazy" />' : '<span style="padding:1rem;color:var(--muted)">No image</span>') +
          '</div>' +
          '<div class="nft-meta"><span class="token-id">#' + tokenId + '</span>' + (meta.name ? ' · ' + escapeHtml(String(meta.name)) : '') + '</div>';
        slot.classList.add('loaded');
        slot.style.animationDelay = delay + 'ms';
        slot.addEventListener('click', function () { openModal(tokenId); });
      })
      .catch(function (err) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[NFT viewer] token', tokenId, err && err.message ? err.message : err);
        slot.innerHTML = '<div class="nft-thumb"><span style="padding:1rem;color:var(--muted)">#' + tokenId + '</span></div>' +
          '<div class="nft-meta"><span class="token-id">#' + tokenId + '</span> · unavailable</div>';
        slot.classList.add('loaded');
        slot.style.animationDelay = delay + 'ms';
      });
  }

  // ----- Init -----

  if (!slug) { showErr('Missing ?slug= in URL. Go back to the home page.'); return; }

  fetch('/collections.json')
    .then(function (r) { if (!r.ok) throw new Error('collections.json'); return r.json(); })
    .then(function (data) {
      var list = (data && data.collections) || [];
      var cfg = list.find(function (c) { return c.slug === slug; });
      if (!cfg) throw new Error('Unknown collection');
      var addr = (cfg.contractAddress || '').trim();
      if (!addr || addr.indexOf('REPLACE') === 0) throw new Error('Set contractAddress in collections.json');

      titleEl.textContent = cfg.name || slug;
      subEl.textContent = addr;

      return apiGetInfo(addr).then(function (info) { return { cfg: cfg, addr: addr, info: info }; });
    })
    .then(function (ctx) {
      var cfg = ctx.cfg, addr = ctx.addr, info = ctx.info;
      if (info.ok && info.name) titleEl.textContent = info.name;

      if (statsEl && info.ok) {
        var parts = [];
        if (info.totalSupply != null) parts.push('<span class="stat"><strong>' + info.totalSupply + '</strong> items</span>');
        if (info.symbol) parts.push('<span class="stat">Symbol: <strong>' + escapeHtml(info.symbol) + '</strong></span>');
        statsEl.innerHTML = parts.join('');
      }

      var start = Math.max(0, parseInt(cfg.tokenIdStart, 10) || 1);
      var end = (info.ok && info.totalSupply > 0) ? start + info.totalSupply - 1 : (cfg.tokenIdEnd != null ? parseInt(cfg.tokenIdEnd, 10) : NaN);
      if (!Number.isFinite(end)) throw new Error('Could not determine token range.');

      var ids = [];
      for (var i = start; i <= end; i++) ids.push(i);
      var maxTokens = parseInt(cfg.maxTokens, 10);
      if (!Number.isFinite(maxTokens) || maxTokens < 1) maxTokens = 2000;
      if (ids.length > maxTokens) { showErr('Too many tokens (' + ids.length + ').'); return; }

      if (!gridEl) return;
      gridEl.innerHTML = '';

      var PAGE_SIZE = parseInt(cfg.pageSize, 10);
      if (!Number.isFinite(PAGE_SIZE) || PAGE_SIZE < 1) PAGE_SIZE = 50;
      var parallel = parseInt(cfg.loadParallel, 10);
      if (!Number.isFinite(parallel) || parallel < 1) parallel = 2;

      var pageStart = 0;
      var pagerWrap = document.createElement('div');
      pagerWrap.className = 'pager';
      gridEl.parentNode.insertBefore(pagerWrap, gridEl.nextSibling);

      function loadPage() {
        var pageIds = ids.slice(pageStart, pageStart + PAGE_SIZE);
        if (!pageIds.length) return;

        gridEl.innerHTML = '';
        var tasks = pageIds.map(function (id, idx) {
          var slot = document.createElement('div');
          slot.className = 'card clickable';
          slot.innerHTML = '<div class="skeleton skeleton-thumb"></div><div class="skeleton skeleton-text"></div>';
          gridEl.appendChild(slot);
          return { id: id, slot: slot, delay: Math.min(idx * 15, 300) };
        });

        window.scrollTo({ top: gridEl.offsetTop - 80, behavior: 'smooth' });

        poolLimit(tasks, parallel, function (t) {
          return apiGetTokenURI(addr, t.id)
            .then(function (resp) { return renderToken(t.id, resp && resp.ok ? resp.tokenURI : null, t.slot, t.delay); })
            .catch(function () { return renderToken(t.id, null, t.slot, t.delay); });
        });

        renderPager();
      }

      function renderPager() {
        var totalPages = Math.ceil(ids.length / PAGE_SIZE);
        var currentPage = Math.floor(pageStart / PAGE_SIZE);
        pagerWrap.innerHTML = '';

        if (totalPages <= 1) return;

        function mkBtn(label, page, disabled, active) {
          var btn = document.createElement('button');
          btn.className = 'pager-btn' + (active ? ' active' : '');
          btn.textContent = label;
          btn.disabled = disabled;
          if (!disabled && !active) {
            btn.addEventListener('click', function () {
              pageStart = page * PAGE_SIZE;
              loadPage();
            });
          }
          return btn;
        }

        pagerWrap.appendChild(mkBtn('←', currentPage - 1, currentPage === 0, false));

        var startP = Math.max(0, currentPage - 3);
        var endP = Math.min(totalPages - 1, currentPage + 3);
        if (startP > 0) {
          pagerWrap.appendChild(mkBtn('1', 0, false, currentPage === 0));
          if (startP > 1) {
            var dots = document.createElement('span');
            dots.className = 'pager-dots';
            dots.textContent = '…';
            pagerWrap.appendChild(dots);
          }
        }
        for (var p = startP; p <= endP; p++) {
          pagerWrap.appendChild(mkBtn(String(p + 1), p, false, p === currentPage));
        }
        if (endP < totalPages - 1) {
          if (endP < totalPages - 2) {
            var dots2 = document.createElement('span');
            dots2.className = 'pager-dots';
            dots2.textContent = '…';
            pagerWrap.appendChild(dots2);
          }
          pagerWrap.appendChild(mkBtn(String(totalPages), totalPages - 1, false, currentPage === totalPages - 1));
        }

        pagerWrap.appendChild(mkBtn('→', currentPage + 1, currentPage === totalPages - 1, false));
      }

      hideLoading();
      loadPage();
    })
    .catch(function (e) { showErr(e.message || String(e)); });
})();
