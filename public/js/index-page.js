(function () {
  'use strict';

  var listEl = document.getElementById('collection-list');
  var errEl = document.getElementById('index-error');

  function showErr(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function truncate(s, n) {
    if (!s || s.length <= n) return s;
    return s.slice(0, 10) + '…' + s.slice(-8);
  }

  fetch('/collections.json')
    .then(function (r) {
      if (!r.ok) throw new Error('Could not load collections.json');
      return r.json();
    })
    .then(function (data) {
      var items = (data && data.collections) || [];
      if (!listEl) return;
      listEl.innerHTML = '';
      if (!items.length) {
        showErr('No collections configured.');
        return;
      }
      items.forEach(function (c, idx) {
        var slug = c.slug || '';
        var name = c.name || slug;
        var addr = (c.contractAddress || '').trim();
        var placeholder = !addr || addr.indexOf('REPLACE') === 0;

        var card = document.createElement('a');
        card.href = 'collection.html?slug=' + encodeURIComponent(slug);
        card.className = 'card loaded';
        card.style.animationDelay = (idx * 60) + 'ms';
        card.innerHTML =
          '<div class="card-img" style="background:linear-gradient(135deg,#1a1a2e,#16213e);display:flex;align-items:center;justify-content:center;">' +
          '<span style="font-size:2.5rem;opacity:0.5;">&#128049;</span>' +
          '</div>' +
          '<div class="card-body">' +
          '<h2>' + escapeHtml(name) + '</h2>' +
          '<p>' + (placeholder ? 'Contract not set' : truncate(addr, 42)) + '</p>' +
          '</div>';

        listEl.appendChild(card);
      });
    })
    .catch(function (e) {
      showErr(e.message || 'Failed to load');
    });
})();
