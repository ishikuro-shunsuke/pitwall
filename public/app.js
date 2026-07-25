const state = {
  view: 'timeline',
  order: 'desc',
  repos: new Set(),
  agents: new Set(),
  entries: new Map(),
  repoOptions: [],
  composers: new Set(),
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
};

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

el.filterRepo.addEventListener('change', () => {
  state.repos = new Set([...el.filterRepo.selectedOptions].map((o) => o.value));
  render();
});

el.filterAgent.addEventListener('change', () => {
  state.agents = new Set([...el.filterAgent.selectedOptions].map((o) => o.value));
  render();
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
  if (
    entry.agent === 'claude'
    && entry.status === 'waiting'
    && entry.claudeBlockCeiling
    && entry.sessionBlocks >= entry.claudeBlockCeiling - 2
  ) {
    chips.push(
      `<span class="chip warn" title="Claude Stop-hook consecutive blocks">blocks ${entry.sessionBlocks}/${entry.claudeBlockCeiling}</span>`,
    );
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
  return `<details class="turn-fold"><summary>${entry.turnMessages.length - 1} earlier message(s) this turn</summary><pre>${esc(earlier)}</pre></details>`;
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
    parts.push(`<button type="button" class="btn primary" data-act="reply-toggle" data-id="${esc(entry.id)}">Reply</button>`);
    parts.push(`<button type="button" class="btn danger" data-act="dismiss" data-id="${esc(entry.id)}">Close without reply</button>`);
  } else if (entry.status === 'notice') {
    parts.push(`<button type="button" class="btn" data-act="dismiss" data-id="${esc(entry.id)}">Archive</button>`);
  }

  if (links.openWorkspace) {
    parts.push(`<a class="btn" href="${esc(links.openWorkspace)}">Open in Cursor</a>`);
  }
  if (links.openTranscript) {
    parts.push(`<a class="btn" href="${esc(links.openTranscript)}">Transcript</a>`);
  }
  if (links.resumeCommand) {
    parts.push(`<button type="button" class="btn" data-act="copy" data-copy="${esc(links.resumeCommand)}">Copy resume cmd</button>`);
  }

  let composer = '';
  if (state.composers.has(entry.id) && entry.status === 'waiting') {
    composer = `
      <div class="composer" data-composer="${esc(entry.id)}">
        <textarea placeholder="Reply goes back into the same agent turn…" data-reply-input="${esc(entry.id)}"></textarea>
        <div class="composer-row">
          <button type="button" class="btn primary" data-act="send" data-id="${esc(entry.id)}">Send &amp; archive</button>
          <button type="button" class="btn" data-act="reply-cancel" data-id="${esc(entry.id)}">Cancel</button>
        </div>
      </div>`;
  }

  if (entry.reply) {
    composer += `<p class="meta" style="margin:8px 0 0">replied: ${esc(entry.reply)}</p>`;
  }

  return `<div class="card-actions">${parts.join('')}${composer}</div>`;
}

function cardHtml(entry) {
  const repo = entry.repo || {};
  const branch = repo.branch ? `@${repo.branch}` : '';
  const dirty = repo.dirty ? ' • dirty' : '';
  return `
    <article class="card" data-id="${esc(entry.id)}" data-agent="${esc(entry.agent)}" data-status="${esc(entry.status)}">
      <div class="card-head">
        <span class="badge ${esc(entry.agent)}">${esc(entry.agent)}</span>
        <span class="badge status-${esc(entry.status)}">${esc(entry.status)}</span>
        <span class="meta">${esc(repo.name || 'unknown')}${esc(branch)}${esc(dirty)}</span>
        <span class="meta" title="${esc(entry.createdAt)}">${fmtAge(entry.createdAt, nowMs())}</span>
        <div class="chips">${holdChip(entry)}${modelChips(entry)}</div>
      </div>
      <div class="card-body">
        <pre class="body-text">${esc(entry.body || entry.notice || '(empty)')}</pre>
        ${turnsHtml(entry)}
        ${imagesHtml(entry)}
      </div>
      ${actionsHtml(entry)}
    </article>`;
}

function renderRepoOptions() {
  const prev = new Set([...el.filterRepo.selectedOptions].map((o) => o.value));
  el.filterRepo.innerHTML = state.repoOptions
    .map((r) => `<option value="${esc(r.key)}" ${prev.has(r.key) ? 'selected' : ''}>${esc(r.name)} (${r.active}/${r.total})</option>`)
    .join('');
}

function render() {
  const items = selectedEntries();
  el.timeline.innerHTML = items.map(cardHtml).join('');
  el.empty.classList.toggle('hidden', items.length > 0);

  // Restore composer text if any
  for (const id of state.composers) {
    const input = el.timeline.querySelector(`[data-reply-input="${CSS.escape(id)}"]`);
    if (input) input.focus();
  }
}

function upsert(entry) {
  if (!entry?.id) return;
  state.entries.set(entry.id, entry);
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
  stopHoldHeartbeat(id);
  const tick = async () => {
    if (!state.composers.has(id)) return;
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
    if (act === 'reply-toggle') {
      state.composers.add(id);
      startHoldHeartbeat(id);
      render();
      return;
    }
    if (act === 'reply-cancel') {
      state.composers.delete(id);
      stopHoldHeartbeat(id);
      render();
      return;
    }
    if (act === 'send') {
      const input = el.timeline.querySelector(`[data-reply-input="${CSS.escape(id)}"]`);
      const message = input?.value?.trim();
      if (!message) return;
      await api(`/api/entries/${id}/reply`, { message });
      state.composers.delete(id);
      stopHoldHeartbeat(id);
      await refresh();
      return;
    }
    if (act === 'dismiss') {
      await api(`/api/entries/${id}/dismiss`);
      state.composers.delete(id);
      stopHoldHeartbeat(id);
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
          active: entry.status === 'waiting' || entry.status === 'notice' ? 1 : 0,
          total: 1,
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
