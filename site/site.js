/*
 * safe-to-merge site: interactive verdict card.
 * Verdict "decrypt" effect adapted from DecryptedText by React Bits
 * (https://reactbits.dev), Copyright (c) 2026 David Haz, MIT + Commons Clause.
 */
(function () {
  var V = {
    safe: { fg: '#4CC38A', bg: 'rgba(76,195,138,0.12)' },
    review: { fg: '#E8A44B', bg: 'rgba(232,164,75,0.12)' },
    block: { fg: '#F2685D', bg: 'rgba(242,104,93,0.12)' }
  };
  var SAMPLES = {
    safe: {
      label: 'Safe to merge', glyph: 'M4.5 9.4l3 3 6-6.3', reasons: [],
      jev: { safe: 0.91, needs_review: 0.07, block: 0.02 }
    },
    review: {
      label: 'Needs human review', glyph: 'M9 4.5v5.5M9 13.4v.1',
      reasons: [
        { text: 'Code changes look under-tested (15% adequate).', src: 'Jev', v: 'review' },
        { text: 'e2e failed — looks flaky (88%). Re-run it.', src: 'Jev', v: 'review' }
      ],
      jev: { safe: 0.18, needs_review: 0.74, block: 0.08 }
    },
    block: {
      label: 'Not safe to merge', glyph: 'M5.5 5.5l7 7M12.5 5.5l-7 7',
      reasons: [
        { text: '@lee requested changes.', src: 'rule', v: 'block' },
        { text: 'Unresolved blocking thread on src/auth/session.js (82%).', src: 'Jev', v: 'block' }
      ],
      jev: { safe: 0.03, needs_review: 0.21, block: 0.76 }
    }
  };
  var POOL = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=<>/';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, style, text) {
    var n = document.createElement(tag);
    if (style) n.setAttribute('style', style);
    if (text != null) n.textContent = text;
    return n;
  };
  var MONO = "font-family: 'JetBrains Mono', ui-monospace, monospace;";
  var tabs = Array.prototype.slice.call(document.querySelectorAll('button[data-verdict]'));
  var current = 'block';
  var timer = null;

  function renderStatic() {
    var s = SAMPLES[current];
    var c = V[current];
    tabs.forEach(function (b) {
      var on = b.dataset.verdict === current;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.style.background = on ? '#F386A1' : 'transparent';
      b.style.color = on ? '#0D0D0D' : '#A0A0A0';
    });
    $('v-icon').style.background = c.bg;
    $('v-glyph').setAttribute('d', s.glyph);
    $('v-glyph').style.stroke = c.fg;
    $('v-sr').textContent = s.label;
    $('v-empty').hidden = s.reasons.length > 0;

    var ul = $('v-reasons');
    ul.textContent = '';
    s.reasons.forEach(function (r) {
      var jev = r.src === 'Jev';
      var li = el('li', 'display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 10px; background: #0D0D0D; font-size: 14px; line-height: 1.4');
      li.appendChild(el('span', 'flex: none; width: 6px; height: 6px; border-radius: 50%; background: ' + V[r.v].fg)).setAttribute('aria-hidden', 'true');
      li.appendChild(el('span', 'flex: 1; color: #CCCCCC', r.text));
      li.appendChild(el('span', 'flex: none; padding: 2px 8px; border-radius: 999px; ' + MONO + ' font-size: 11px; background: ' + (jev ? '#F386A1' : '#242424') + '; color: ' + (jev ? '#0D0D0D' : '#A0A0A0'), r.src));
      ul.appendChild(li);
    });

    var bars = $('v-bars');
    var top = Object.keys(s.jev).reduce(function (a, b) { return s.jev[a] >= s.jev[b] ? a : b; });
    if (!bars.children.length) {
      Object.keys(s.jev).forEach(function (k) {
        var row = el('div', 'display: grid; grid-template-columns: 6.75rem minmax(0, 1fr) 2.25rem; gap: 12px; align-items: center; ' + MONO + ' font-size: 12px');
        row.dataset.key = k;
        row.appendChild(el('span', '', k));
        var track = el('span', 'display: block; height: 6px; border-radius: 999px; background: #FFFFFF; overflow: hidden');
        track.appendChild(el('span', 'display: block; height: 100%; border-radius: 999px; width: 0; transition: width .5s cubic-bezier(.22,1,.36,1)'));
        row.appendChild(track);
        row.appendChild(el('span', 'text-align: right'));
        bars.appendChild(row);
      });
    }
    Array.prototype.forEach.call(bars.children, function (row) {
      var k = row.dataset.key, p = s.jev[k], on = k === top;
      row.children[0].style.fontWeight = on ? 600 : 400;
      row.children[1].firstChild.style.width = Math.max(2, Math.round(p * 100)) + '%';
      row.children[1].firstChild.style.background = on ? '#0D0D0D' : '#8C8C8C';
      row.children[2].textContent = p.toFixed(2);
      row.children[2].style.fontWeight = on ? 600 : 400;
    });
  }

  function renderLabel(text, revealed, running) {
    var label = $('v-label');
    label.textContent = '';
    var word = null;
    Array.from(text).forEach(function (ch, i) {
      if (ch === ' ') { word = null; return; }
      if (!word) { word = el('span', 'display: inline-block; white-space: nowrap'); label.appendChild(word); }
      var cell = el('span', 'position: relative; display: inline-block');
      var ghost = el('span', '', ch);
      cell.appendChild(ghost);
      if (i >= revealed) {
        ghost.style.visibility = 'hidden';
        var lead = Math.max(0, 1 - (i - revealed) / 6);
        cell.appendChild(el('span', 'position: absolute; top: 0; left: 50%; transform: translateX(-50%); color: #F386A1; opacity: ' + (0.35 + 0.55 * lead).toFixed(2), POOL[Math.floor(Math.random() * POOL.length)]));
      }
      word.appendChild(cell);
    });
    $('v-status').textContent = running ? 'jev deciding…' : 'jev decided';
    $('v-dot').style.opacity = running ? 1 : 0.5;
    $('v-icon').style.opacity = running ? 0.3 : 1;
  }

  function decrypt(text) {
    clearInterval(timer);
    if (reduced) { renderLabel(text, text.length, false); return; }
    var revealed = 0, iter = 0;
    renderLabel(text, 0, true);
    timer = setInterval(function () {
      iter += 1;
      if (iter > 6) revealed += 1;
      while (revealed < text.length && text[revealed] === ' ') revealed += 1;
      var done = revealed >= text.length;
      renderLabel(text, Math.min(revealed, text.length), !done);
      if (done) clearInterval(timer);
    }, 42);
  }

  tabs.forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.dataset.verdict === current) return;
      current = b.dataset.verdict;
      renderStatic();
      decrypt(SAMPLES[current].label);
    });
  });

  renderStatic();
  decrypt(SAMPLES[current].label);
})();
