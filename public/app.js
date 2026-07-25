const state = {
  view: 'timeline',
  order: 'desc',
  repos: new Set(),
  agents: new Set(),
  entries: new Map(),
  repoOptions: [],
  drafts: new Map(),
  engaged: new Set(),
  holdTimers: new Map(),
  serverSkew: 0,
};

const el = {
  timeline: document.getElementById('timeline'),
  empty: document.getElementById('empty'),
  status: document.getElementById('status-dot'),
  filterRepo: document.getElementById('filter-repo'),
  filterAgent: document.getElementById('filter-agent'),
  filterOrder: document.getElementById('filter-order'),
  lightbox: document.getElementById('lightbox'),
  lightboxImg: document.getElementById('lightbox-img'),
  lightboxCap: document.getElementById('lightbox-cap'),
  themeToggle: document.getElementById('theme-toggle'),
};

const systemTheme = window.matchMedia('(prefers-color-scheme: light)');

function currentTheme() {
  return document.documentElement.dataset.theme
    || (systemTheme.matches ? 'light' : 'dark');
}

function paintThemeToggle() {
  const theme = currentTheme();
  el.themeToggle.textContent = theme;
  el.themeToggle.title = `switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
}

el.themeToggle.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('pitwall.theme', next);
  } catch { /* ignore */ }
  paintThemeToggle();
});

// Until a choice is made, follow the OS.
systemTheme.addEventListener('change', paintThemeToggle);
paintThemeToggle();

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.view = btn.dataset.view;
    refresh();
  });
});

el.filterOrder.addEventListener('change', () => {
  state.order = el.filterOrder.value;
  render();
});

function toggleChip(group, set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
  for (const chip of group.querySelectorAll('.filter-chip')) {
    chip.setAttribute('aria-pressed', String(set.has(chip.dataset.value)));
  }
  render();
}

el.filterRepo.addEventListener('click', (e) => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  toggleChip(el.filterRepo, state.repos, chip.dataset.value);
});

el.filterAgent.addEventListener('click', (e) => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  toggleChip(el.filterAgent, state.agents, chip.dataset.value);
});

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
el.lightbox.addEventListener('click', (e) => {
  if (e.target === el.lightbox) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLightbox();
});

function closeLightbox() {
  el.lightbox.classList.add('hidden');
  el.lightboxImg.removeAttribute('src');
}

function openLightbox(url, cap) {
  el.lightboxImg.src = url;
  el.lightboxCap.textContent = cap || '';
  el.lightbox.classList.remove('hidden');
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fmtAge(iso, now = Date.now()) {
  const ms = Math.max(0, now - Date.parse(iso));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtRemain(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}

function nowMs() {
  return Date.now() + state.serverSkew;
}

function repoColor(key) {
  if (!key) return null;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}deg 65% var(--repo-l))`;
}

function selectedEntries() {
  let items = [...state.entries.values()];
  if (state.view === 'timeline') {
    items = items.filter((e) => e.status === 'waiting' || e.status === 'notice');
  } else {
    items = items.filter((e) => !['waiting', 'notice'].includes(e.status));
  }
  if (state.repos.size) items = items.filter((e) => state.repos.has(e.repo?.key));
  if (state.agents.size) items = items.filter((e) => state.agents.has(e.agent));
  items.sort((a, b) => {
    const da = Date.parse(a.createdAt);
    const db = Date.parse(b.createdAt);
    return state.order === 'asc' ? da - db : db - da;
  });
  return items;
}

function modelChips(entry) {
  const chips = [];
  const m = entry.model || {};
  if (m.label || m.id) chips.push(`<span class="chip" title="model">${esc(m.label || m.id)}</span>`);
  if (m.effort) chips.push(`<span class="chip" title="effort">effort:${esc(m.effort)}</span>`);
  if (m.permissionMode) chips.push(`<span class="chip" title="permission">${esc(m.permissionMode)}</span>`);
  if (m.agentType) chips.push(`<span class="chip" title="agent type">${esc(m.agentType)}</span>`);
  for (const p of m.params || []) {
    if (!p.id) continue;
    if (p.id === 'effort' && m.effort) continue;
    chips.push(`<span class="chip" title="${esc(p.id)}">${esc(p.id)}:${esc(p.value)}</span>`);
  }
  if (entry.backgroundTaskCount > 0) {
    chips.push(`<span class="chip warn">bg:${entry.backgroundTaskCount}</span>`);
  }
  return chips.join('');
}

function imagesHtml(entry) {
  if (!entry.images?.length) return '';
  const parts = entry.images.map((img) => {
    if (img.missing || !img.url) {
      return `<span class="img-missing" title="${esc(img.error || '')}">missing: ${esc(img.ref)}</span>`;
    }
    return `<button type="button" data-img="${esc(img.url)}" data-cap="${esc(img.name || img.ref)}"><img src="${esc(img.url)}" alt="${esc(img.name || '')}" loading="lazy" /></button>`;
  });
  return `<div class="images">${parts.join('')}</div>`;
}

function turnsHtml(entry) {
  if (!entry.turnMessages || entry.turnMessages.length <= 1) return '';
  const earlier = entry.turnMessages.slice(0, -1).join('\n\n---\n\n');
  return `<details class="turn-fold"><summary>${entry.turnMessages.length - 1} earlier message(s) this turn</summary><div class="markdown">${renderMarkdown(earlier)}</div></details>`;
}

function inlineMd(s) {
  return s
    .replace(/`([^`]+?)`/g, (_m, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+?)\*\*|__([^_]+?)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/\*([^*]+?)\*|_([^_]+?)_/g, (_m, a, b) => `<em>${a ?? b}</em>`)
    .replace(/\[([^\]]+?)\]\((https?:\/\/[^\s)]+?)\)/g, (_m, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
}

function renderMarkdown(raw) {
  const lines = esc(raw).split('\n');
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inlineMd(para.join('<br>'))}</p>`);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const lang = fence[1] ? ` data-lang="${fence[1]}"` : '';
      out.push(`<pre class="md-code"><code${lang}>${codeLines.join('\n')}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      flushPara();
      const quoteLines = [quote[1]];
      i++;
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^&gt;\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inlineMd(quoteLines.join('<br>'))}</blockquote>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      const items = [ul[1]];
      i++;
      while (i < lines.length) {
        const m2 = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (!m2) break;
        items.push(m2[1]);
        i++;
      }
      out.push(`<ul>${items.map((it) => `<li>${inlineMd(it)}</li>`).join('')}</ul>`);
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      const items = [ol[1]];
      i++;
      while (i < lines.length) {
        const m2 = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        if (!m2) break;
        items.push(m2[1]);
        i++;
      }
      out.push(`<ol>${items.map((it) => `<li>${inlineMd(it)}</li>`).join('')}</ol>`);
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}

function holdChip(entry) {
  if (entry.status !== 'waiting') return '';
  const remain = Math.max(0, (entry.holdUntil || 0) - nowMs());
  let cls = 'hold';
  if (remain < 20_000) cls += ' critical';
  else if (remain < 45_000) cls += ' low';
  return `<span class="chip ${cls}" data-hold="${esc(entry.id)}">hold ${fmtRemain(remain)}</span>`;
}

function actionsHtml(entry) {
  const links = entry.links || {};
  const parts = [];

  if (entry.status === 'waiting') {
    parts.push(`<button type="button" class="btn primary" data-act="send" data-id="${esc(entry.id)}">Send &amp; archive</button>`);
    parts.push(`<button type="button" class="btn danger" data-act="dismiss" data-id="${esc(entry.id)}">Close without reply</button>`);
  } else if (entry.status === 'notice') {
    parts.push(`<button type="button" class="btn" data-act="dismiss" data-id="${esc(entry.id)}">Archive</button>`);
  }

  if (links.openWorkspace) {
    parts.push(`<a class="btn" href="${esc(links.openWorkspace)}">Open in Cursor</a>`);
  }
  if (links.resumeCommand) {
    parts.push(`<button type="button" class="btn" data-act="copy" data-copy="${esc(links.resumeCommand)}">Copy resume cmd</button>`);
  }

  let composer = '';
  if (entry.status === 'waiting') {
    composer = `
      <div class="composer" data-composer="${esc(entry.id)}">
        <textarea placeholder="Reply goes back into the same agent turn…" data-reply-input="${esc(entry.id)}">${esc(state.drafts.get(entry.id) || '')}</textarea>
      </div>`;
  }

  let trailer = '';
  if (entry.reply) {
    trailer = `<p class="meta" style="margin:8px 0 0">replied: ${esc(entry.reply)}</p>`;
  }

  return `<div class="card-actions">${composer}${parts.join('')}${trailer}</div>`;
}

function cardHtml(entry) {
  const repo = entry.repo || {};
  const branch = repo.branch ? `@${repo.branch}` : '';
  const dirty = repo.dirty ? ' • dirty' : '';
  const color = repoColor(repo.key || repo.name);
  const style = color ? ` style="--repo-color: ${color}"` : '';
  return `
    <article class="card" data-id="${esc(entry.id)}" data-agent="${esc(entry.agent)}" data-status="${esc(entry.status)}"${style}>
      <div class="card-head">
        <span class="badge ${esc(entry.agent)}">${esc(entry.agent)}</span>
        <span class="badge status-${esc(entry.status)}">${esc(entry.status)}</span>
        <span class="meta">${esc(repo.name || 'unknown')}${esc(branch)}${esc(dirty)}</span>
        <span class="meta" title="${esc(entry.createdAt)}">${fmtAge(entry.createdAt, nowMs())}</span>
        <div class="chips">${holdChip(entry)}${modelChips(entry)}</div>
      </div>
      <div class="card-body">
        ${entry.title ? `<p class="card-title">${esc(entry.title)}</p>` : ''}
        <div class="body-text markdown">${renderMarkdown(entry.body || entry.notice || '(empty)')}</div>
        ${turnsHtml(entry)}
        ${imagesHtml(entry)}
      </div>
      ${actionsHtml(entry)}
    </article>`;
}

function renderRepoOptions() {
  el.filterRepo.innerHTML = state.repoOptions
    .map((r) => `<button type="button" class="filter-chip" data-value="${esc(r.key)}" aria-pressed="${state.repos.has(r.key)}">${esc(r.name)}</button>`)
    .join('');
}

function render() {
  // A card can be replaced mid-sentence by an SSE update, so carry the caret
  // across the swap along with the draft text.
  const active = document.activeElement;
  const focused = active?.hasAttribute?.('data-reply-input')
    ? {
      id: active.getAttribute('data-reply-input'),
      start: active.selectionStart,
      end: active.selectionEnd,
    }
    : null;

  const items = selectedEntries();
  el.timeline.innerHTML = items.map(cardHtml).join('');
  el.empty.classList.toggle('hidden', items.length > 0);

  if (focused) {
    const input = el.timeline.querySelector(`[data-reply-input="${CSS.escape(focused.id)}"]`);
    if (input) {
      input.focus();
      input.setSelectionRange(focused.start, focused.end);
    }
  }
}

function upsert(entry) {
  if (!entry?.id) return;
  state.entries.set(entry.id, entry);
  if (entry.status !== 'waiting') release(entry.id);
}

/** The entry can no longer take a reply — drop the draft and stop holding it. */
function release(id) {
  state.drafts.delete(id);
  state.engaged.delete(id);
  stopHoldHeartbeat(id);
}

async function refresh() {
  const params = new URLSearchParams({ view: 'all', order: state.order });
  // Fetch everything; client filters by tab so SSE updates stay consistent.
  params.set('view', state.view === 'archive' ? 'archive' : 'timeline');
  // Also pull the other side so SSE merges don't lose context — use two calls.
  const [a, b] = await Promise.all([
    fetch('/api/entries?view=timeline&order=' + state.order).then((r) => r.json()),
    fetch('/api/entries?view=archive&order=' + state.order).then((r) => r.json()),
  ]);
  if (a.serverTime) state.serverSkew = a.serverTime - Date.now();
  state.entries.clear();
  for (const e of [...(a.entries || []), ...(b.entries || [])]) upsert(e);
  state.repoOptions = a.repos || b.repos || [];
  renderRepoOptions();
  render();
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : '{}',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function startHoldHeartbeat(id) {
  if (state.holdTimers.has(id)) return;
  const tick = async () => {
    if (!state.engaged.has(id)) return;
    try {
      const data = await api(`/api/entries/${id}/hold`);
      const entry = state.entries.get(id);
      if (entry && data.holdUntil) {
        entry.holdUntil = data.holdUntil;
        entry.holdRemainingMs = data.remainingMs;
        const chip = el.timeline.querySelector(`[data-hold="${CSS.escape(id)}"]`);
        if (chip) {
          let cls = 'chip hold';
          if (data.remainingMs < 20_000) cls += ' critical';
          else if (data.remainingMs < 45_000) cls += ' low';
          chip.className = cls;
          chip.textContent = `hold ${fmtRemain(data.remainingMs)}`;
        }
      }
    } catch {
      stopHoldHeartbeat(id);
    }
  };
  tick();
  const timer = setInterval(tick, 20_000);
  state.holdTimers.set(id, timer);
}

function stopHoldHeartbeat(id) {
  const t = state.holdTimers.get(id);
  if (t) clearInterval(t);
  state.holdTimers.delete(id);
}

// The form is on screen for every waiting entry, but only the one you touch
// gets to hold its agent open.
el.timeline.addEventListener('focusin', (e) => {
  const id = e.target.getAttribute?.('data-reply-input');
  if (!id) return;
  state.engaged.add(id);
  startHoldHeartbeat(id);
});

el.timeline.addEventListener('focusout', (e) => {
  const id = e.target.getAttribute?.('data-reply-input');
  if (!id || !e.target.isConnected) return; // a re-render swapped the field out
  if (state.drafts.get(id)) return; // keep holding while a draft is standing
  state.engaged.delete(id);
  stopHoldHeartbeat(id);
});

el.timeline.addEventListener('input', (e) => {
  const id = e.target.getAttribute?.('data-reply-input');
  if (!id) return;
  state.drafts.set(id, e.target.value);
});

el.timeline.addEventListener('keydown', (e) => {
  const id = e.target.getAttribute?.('data-reply-input');
  if (!id) return;
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  el.timeline.querySelector(`[data-act="send"][data-id="${CSS.escape(id)}"]`)?.click();
});

el.timeline.addEventListener('click', async (e) => {
  const imgBtn = e.target.closest('[data-img]');
  if (imgBtn) {
    openLightbox(imgBtn.dataset.img, imgBtn.dataset.cap);
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;

  try {
    if (act === 'send') {
      const input = el.timeline.querySelector(`[data-reply-input="${CSS.escape(id)}"]`);
      const message = input?.value?.trim();
      if (!message) {
        input?.focus();
        return;
      }
      await api(`/api/entries/${id}/reply`, { message });
      release(id);
      await refresh();
      return;
    }
    if (act === 'dismiss') {
      await api(`/api/entries/${id}/dismiss`);
      release(id);
      await refresh();
      return;
    }
    if (act === 'copy') {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy resume cmd'; }, 1200);
    }
  } catch (err) {
    alert(err.message || String(err));
  }
});

// Countdown tick for hold chips
setInterval(() => {
  for (const chip of el.timeline.querySelectorAll('[data-hold]')) {
    const id = chip.getAttribute('data-hold');
    const entry = state.entries.get(id);
    if (!entry || entry.status !== 'waiting') continue;
    const remain = Math.max(0, (entry.holdUntil || 0) - nowMs());
    let cls = 'chip hold';
    if (remain < 20_000) cls += ' critical';
    else if (remain < 45_000) cls += ' low';
    chip.className = cls;
    chip.textContent = `hold ${fmtRemain(remain)}`;
  }
  // Relative ages
  for (const card of el.timeline.querySelectorAll('.card')) {
    const entry = state.entries.get(card.dataset.id);
    if (!entry) continue;
    const metas = card.querySelectorAll('.card-head > .meta');
    if (metas[1]) metas[1].textContent = fmtAge(entry.createdAt, nowMs());
  }
}, 1000);

function connectSse() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.serverTime) state.serverSkew = data.serverTime - Date.now();
    } catch { /* ignore */ }
    el.status.classList.add('ok');
    el.status.classList.remove('bad');
    el.status.title = 'connected';
  });
  const onEntry = (ev) => {
    try {
      const entry = JSON.parse(ev.data);
      upsert(entry);
      // Keep repo list roughly fresh
      if (entry.repo?.key && !state.repoOptions.some((r) => r.key === entry.repo.key)) {
        state.repoOptions.push({
          key: entry.repo.key,
          name: entry.repo.name,
          root: entry.repo.root,
        });
        renderRepoOptions();
      }
      render();
    } catch { /* ignore */ }
  };
  es.addEventListener('created', onEntry);
  es.addEventListener('updated', onEntry);
  es.onerror = () => {
    el.status.classList.remove('ok');
    el.status.classList.add('bad');
    el.status.title = 'disconnected — retrying';
  };
}

refresh().catch((err) => {
  el.status.classList.add('bad');
  el.empty.textContent = `Failed to load: ${err.message}`;
  el.empty.classList.remove('hidden');
});
connectSse();
