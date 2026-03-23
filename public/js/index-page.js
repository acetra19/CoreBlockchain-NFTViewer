(function () {
  'use strict';

  var listEl = document.getElementById('collection-list');
  var errEl = document.getElementById('index-error');

  function showErr(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.style.display = 'block';
    errEl.className = 'msg err';
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
        showErr('No collections configured. Edit public/collections.json on the server.');
        return;
      }
      items.forEach(function (c) {
        var slug = c.slug || '';
        var name = c.name || slug;
        var addr = (c.contractAddress || '').trim();
        var a = document.createElement('a');
        a.href = 'collection.html?slug=' + encodeURIComponent(slug);
        a.className = 'card block';
        var placeholder = !addr || addr.indexOf('REPLACE') === 0;
        a.innerHTML =
          '<div class="card-body">' +
          '<h2>' + escapeHtml(name) + '</h2>' +
          '<p>' + (placeholder ? 'Set contract address in collections.json' : truncate(addr, 42)) + '</p>' +
          '</div>';
        var wrap = document.createElement('div');
        wrap.className = 'card';
        wrap.appendChild(a);
        listEl.appendChild(wrap);
      });
    })
    .catch(function (e) {
      showErr(e.message || 'Failed to load list');
    });

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function truncate(s, n) {
    if (!s || s.length <= n) return s;
    return s.slice(0, 10) + '…' + s.slice(-8);
  }
})();
