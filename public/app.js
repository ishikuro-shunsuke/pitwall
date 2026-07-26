import { parseFileRef, fileRefLink } from '/deeplink.mjs';

/** Cards painted per page. Scrolling to the end adds another page. */
const PAGE = 20;

const state = {
  view: 'timeline',
  repoQuery: '',
  agents: new Set(),
  unansweredOnly: false,
  limit: PAGE,
  entries: new Map(),
  drafts: new Map(),
  engaged: new Set(),
  holdTimers: new Map(),
  serverSkew: 0,
  // Cards on screen are marked read within the second, so the mark on the card
  // has to outlive the flag: these are the ids that were still unread when this
  // tab last showed them, and they keep their mark until you leave the tab.
  marked: new Set(),
  readPending: new Set(),
};

const el = {
  topbar: document.querySelector('.topbar'),
  timeline: document.getElementById('timeline'),
  empty: document.getElementById('empty'),
  status: document.getElementById('status-dot'),
  filterRepo: document.getElementById('filter-repo'),
  filterAgent: document.getElementById('filter-agent'),
  filterAnswer: document.getElementById('filter-answer'),
  filterUnanswered: document.getElementById('filter-unanswered'),
  more: document.getElementById('more'),
  lightbox: document.getElementById('lightbox'),
  lightboxStage: document.getElementById('lightbox-stage'),
  lightboxImg: document.getElementById('lightbox-img'),
  lightboxCap: document.getElementById('lightbox-cap'),
  lightboxRaw: document.getElementById('lightbox-raw'),
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
  btn.addEventListener('click', (event) => {
    // Clicking the count takes it as read. Scrolling every card past the
    // topbar is the honest way to clear it, but a tab you were never looking
    // at can collect a backlog you have no intention of reading through, and
    // the number has to be able to reach zero. The tab you are already on
    // does the same, so this is reachable from the keyboard too.
    if (event.target.closest('.tab-badge') || state.view === btn.dataset.view) {
      markViewRead(btn.dataset.view);
      return;
    }
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    settleMarks();
    state.view = btn.dataset.view;
    // Nothing in the timeline has finished, so there is nothing to narrow.
    el.filterAnswer.hidden = state.view !== 'archive';
    resetPaging();
    refresh();
  });
});

el.filterUnanswered.addEventListener('click', () => {
  state.unansweredOnly = !state.unansweredOnly;
  el.filterUnanswered.setAttribute('aria-pressed', String(state.unansweredOnly));
  resetPaging();
  render();
});

function toggleChip(group, set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
  for (const chip of group.querySelectorAll('.filter-chip')) {
    chip.setAttribute('aria-pressed', String(set.has(chip.dataset.value)));
  }
  resetPaging();
  render();
}

el.filterRepo.addEventListener('input', () => {
  state.repoQuery = el.filterRepo.value.trim().toLowerCase();
  resetPaging();
  render();
});

el.filterAgent.addEventListener('click', (e) => {
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  toggleChip(el.filterAgent, state.agents, chip.dataset.value);
});

const lightbox = { items: [], index: 0 };

document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
el.lightbox.addEventListener('click', (e) => {
  if (e.target === el.lightbox || e.target === el.lightboxStage) closeLightbox();
});
el.lightboxImg.addEventListener('click', toggleZoom);
el.lightboxImg.addEventListener('load', paintLightboxCap);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeLightbox();
    return;
  }
  if (el.lightbox.classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') stepLightbox(-1);
  else if (e.key === 'ArrowRight') stepLightbox(1);
  else return;
  e.preventDefault();
});

function closeLightbox() {
  el.lightbox.classList.add('hidden');
  el.lightbox.classList.remove('zoomed');
  el.lightboxImg.removeAttribute('src');
  lightbox.items = [];
}

function openLightbox(items, index) {
  lightbox.items = items;
  el.lightbox.classList.remove('hidden');
  showLightbox(index);
}

function stepLightbox(delta) {
  const n = lightbox.items.length;
  if (n < 2) return;
  showLightbox((lightbox.index + delta + n) % n);
}

function showLightbox(index) {
  const item = lightbox.items[index];
  if (!item) return;
  lightbox.index = index;
  el.lightbox.classList.remove('zoomed');
  el.lightboxImg.src = item.url;
  el.lightboxRaw.href = item.url;
  paintLightboxCap();
}

// Natural size only exists once the bytes land, so the caption is painted both
// on navigation and on load.
function paintLightboxCap() {
  const item = lightbox.items[lightbox.index];
  if (!item) return;
  const w = el.lightboxImg.naturalWidth;
  const parts = [item.cap];
  if (w) parts.push(`${w}×${el.lightboxImg.naturalHeight}`);
  if (lightbox.items.length > 1) parts.push(`${lightbox.index + 1}/${lightbox.items.length} · ← →`);
  el.lightboxCap.textContent = parts.filter(Boolean).join(' · ');
}

function toggleZoom() {
  const zoomed = el.lightbox.classList.toggle('zoomed');
  if (!zoomed) return;
  const stage = el.lightboxStage;
  stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
  stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
}

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Back out of `esc` for values that go into a URL rather than into markup. */
function unesc(s) {
  return String(s ?? '')
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
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

/**
 * The hue carries the repo, so everything the card outlines is one colour at
 * four strengths: full for its own edge, half for the edge of a box you can
 * type in, and two washes faint enough to keep text readable — the heavier one
 * on the bands, so they still read as bands.
 *
 * oklch off the app's own tone, so every repo lands at the same weight as
 * every other and as the rest of the interface. The same hues in hsl would
 * hand the yellow repos a glaring card and the blue ones a sunk one.
 *
 * The wheel starts past red and stops short of it: red is the one colour that
 * means something here, and a repo that happened to hash into it would be
 * telling you its card is urgent.
 */
function repoTones(key) {
  if (!key) return null;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const hue = 55 + (Math.abs(hash) % 290);
  const tone = `var(--tone-l) var(--tone-c) ${hue}`;
  return {
    color: `oklch(${tone})`,
    line: `oklch(${tone} / 0.5)`,
    tint: `oklch(${tone} / 0.12)`,
    wash: `oklch(${tone} / 0.05)`,
  };
}

/** What the repo filter matches on: the name you see, plus the path and branch. */
function repoHaystack(entry) {
  const repo = entry.repo || {};
  return [repo.name, repo.root, repo.key, repo.branch].filter(Boolean).join(' ').toLowerCase();
}

function passesFilters(entry) {
  if (entry.bucket === 'archive' && state.unansweredOnly && !entry.unanswered) return false;
  if (state.repoQuery && !repoHaystack(entry).includes(state.repoQuery)) return false;
  if (state.agents.size && !state.agents.has(entry.agent)) return false;
  return true;
}

function selectedEntries() {
  const items = [...state.entries.values()]
    .filter((e) => e.bucket === state.view && passesFilters(e));
  items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return items;
}

/**
 * The badge counts what the filters would show, so whatever it points at is
 * always one tab away — a count you cannot reach by switching tabs would just
 * sit there.
 */
function paintBadges() {
  const counts = { timeline: 0, archive: 0 };
  for (const entry of state.entries.values()) {
    if (entry.readAt || !passesFilters(entry)) continue;
    if (entry.bucket in counts) counts[entry.bucket] += 1;
  }
  for (const badge of document.querySelectorAll('[data-badge]')) {
    const n = counts[badge.dataset.badge];
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
  }
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
    chips.push(`<span class="chip tasks">bg:${entry.backgroundTaskCount}</span>`);
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
  return `<details class="turn-fold"><summary>${entry.turnMessages.length - 1} earlier message(s) this turn</summary><div class="markdown">${renderMarkdown(earlier, entry)}</div></details>`;
}

/**
 * Escaped ref -> stored image, for the links inside the body. The body text is
 * escaped before it is parsed, so the keys have to be escaped to match.
 */
function imageRefs(images) {
  const byRef = new Map();
  for (const img of images || []) {
    if (img.missing || !img.url) continue;
    byRef.set(esc(img.ref), img);
  }
  return byRef;
}

function inlineMd(s, ctx) {
  const images = ctx.images;
  // Protect code/links before *_/__ emphasis — otherwise filenames like
  // compare_paint_1to1.png get eaten mid-path and never match entry.images.
  const slots = [];
  const protect = (html) => {
    const i = slots.length;
    slots.push(html);
    return `\0${i}\0`;
  };

  let out = s.replace(/`([^`]+?)`/g, (_m, code) => protect(`<code>${code}</code>`));
  out = out.replace(/(!?)\[([^\]]*?)\]\(\s*([^\s)]+?)\s*\)/g, (m, bang, text, target) => {
    // A link to one of this entry's own images opens it in the viewer, so the
    // label stays readable and the path still lands somewhere.
    const img = images?.get(target);
    if (img) {
      const cap = img.name || img.ref;
      return protect(
        `<a class="img-link" href="${esc(img.url)}" data-img-open="${esc(img.url)}" data-cap="${esc(cap)}" target="_blank" rel="noopener noreferrer">${text || esc(cap)}</a>`,
      );
    }
    if (text && /^https?:\/\//.test(target)) {
      return protect(`${bang}<a href="${target}" target="_blank" rel="noopener noreferrer">${text}</a>`);
    }

    // A file reference reads as its label — repeating the path in parentheses is
    // most of what makes these paragraphs hard to follow. The path stays in the
    // tooltip, and lands on the line when there is a workspace to anchor it to.
    const ref = parseFileRef(unesc(target));
    if (ref) {
      const label = text || esc(ref.path);
      const href = fileRefLink(ref, ctx.root, ctx.host);
      const tip = ` title="${target}"`;
      return protect(href
        ? `<a class="file-ref" href="${esc(href)}"${tip}>${label}</a>`
        : `<span class="file-ref"${tip}>${label}</span>`);
    }
    return m;
  });

  out = out
    .replace(/\*\*([^*]+?)\*\*|__([^_]+?)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/\*([^*]+?)\*|_([^_]+?)_/g, (_m, a, b) => `<em>${a ?? b}</em>`);

  return out.replace(/\0(\d+)\0/g, (_m, i) => slots[Number(i)]);
}

const TABLE_DELIM = /^\s*\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;

function tableCells(line) {
  const cells = [];
  let cur = '';
  for (let j = 0; j < line.length; j++) {
    if (line[j] === '\\' && line[j + 1] === '|') {
      cur += '|';
      j++;
    } else if (line[j] === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += line[j];
    }
  }
  cells.push(cur);
  if (cells.length > 1 && cells[0].trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

function renderMarkdown(raw, entry) {
  const lines = esc(raw).split('\n');
  const ctx = {
    images: imageRefs(entry?.images),
    root: entry?.repo?.root || entry?.host?.cwd || null,
    host: entry?.host || {},
  };
  const inline = (s) => inlineMd(s, ctx);
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join('<br>'))}</p>`);
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

    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
      const head = tableCells(line);
      const delim = tableCells(lines[i + 1]);
      if (head.length === delim.length) {
        flushPara();
        const align = delim.map((d) => {
          if (/^:-+:$/.test(d)) return ' style="text-align:center"';
          if (/^-+:$/.test(d)) return ' style="text-align:right"';
          return '';
        });
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
          rows.push(tableCells(lines[i]));
          i++;
        }
        const cell = (tag, text, idx) => `<${tag}${align[idx]}>${inline(text || '')}</${tag}>`;
        const thead = `<tr>${head.map((h, idx) => cell('th', h, idx)).join('')}</tr>`;
        const tbody = rows.map((r) => `<tr>${head.map((_h, idx) => cell('td', r[idx], idx)).join('')}</tr>`).join('');
        out.push(`<div class="md-table-wrap"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`);
        continue;
      }
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
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
      out.push(`<blockquote>${inline(quoteLines.join('<br>'))}</blockquote>`);
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
      out.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`);
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
      out.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ol>`);
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

/**
 * `id:act` for every button that has fired and is still waiting on the server.
 * Held here rather than on the element so a re-render mid-flight repaints it lit.
 */
const firing = new Set();

function actionsHtml(entry) {
  const links = entry.links || {};
  const parts = [];
  const lit = (act) => (firing.has(`${entry.id}:${act}`) ? ' firing' : '');

  if (entry.status === 'waiting') {
    parts.push(`<button type="button" class="btn primary${lit('send')}" data-act="send" data-id="${esc(entry.id)}" title="Reply">Radio in</button>`);
    parts.push(`<button type="button" class="btn danger${lit('dismiss')}" data-act="dismiss" data-id="${esc(entry.id)}" title="Archive">Box</button>`);
  } else if (entry.status === 'notice') {
    // Same button as the one beside a reply, and it does the same thing to the
    // card, so it fills with the same colour on the way out.
    parts.push(`<button type="button" class="btn danger${lit('dismiss')}" data-act="dismiss" data-id="${esc(entry.id)}" title="Archive">Box</button>`);
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
  const tones = repoTones(repo.key || repo.name);
  const decl = [`view-transition-name: card-${entry.id.replace(/[^\w-]/g, '-')}`, 'view-transition-class: card'];
  if (tones) {
    decl.push(
      `--repo-color: ${tones.color}`,
      `--repo-line: ${tones.line}`,
      `--repo-tint: ${tones.tint}`,
      `--repo-wash: ${tones.wash}`,
    );
  }
  const style = ` style="${decl.join('; ')}"`;
  const unread = state.marked.has(entry.id) ? ` data-unread="${esc(entry.bucket)}"` : '';
  return `
    <article class="card" data-id="${esc(entry.id)}" data-agent="${esc(entry.agent)}" data-status="${esc(entry.status)}"${unread}${style}>
      <div class="card-head">
        <span class="badge ${esc(entry.agent)}">${esc(entry.agent)}</span>
        <span class="badge status-${esc(entry.status)}">${esc(entry.status)}</span>
        <span class="meta">${esc(repo.name || 'unknown')}${esc(branch)}${esc(dirty)}</span>
        <span class="meta" title="${esc(entry.createdAt)}">${fmtAge(entry.createdAt, nowMs())}</span>
        <div class="chips">${holdChip(entry)}${modelChips(entry)}</div>
      </div>
      <div class="card-body">
        ${entry.title ? `<p class="card-title">${esc(entry.title)}</p>` : ''}
        <div class="body-text markdown">${renderMarkdown(entry.body || entry.notice || '(empty)', entry)}</div>
        ${turnsHtml(entry)}
        ${imagesHtml(entry)}
      </div>
      ${actionsHtml(entry)}
    </article>`;
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let painted = null;
let animating = false;
let queued = false;
/** id → 'left' | 'right' — reply slides right, archive slides left. */
const exits = new Map();

/** Stamp the live card so the old snapshot leaves in the right direction. */
function applyExits(nextIds) {
  for (const [id, dir] of exits) {
    if (nextIds.has(id)) continue;
    const card = el.timeline.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (card) card.style.viewTransitionClass = dir === 'right' ? 'card leave-right' : 'card leave-left';
    exits.delete(id);
  }
}

function render() {
  // The browser snapshots the cards a frame after a transition starts and holds
  // that picture until it ends, so a repaint landing in between takes the
  // departing card away before it has been drawn leaving. Replying repaints
  // twice — the server's own event, then the refresh behind it — and either one
  // can be the one that lands there, so the second waits its turn.
  if (animating) {
    queued = true;
    return;
  }

  const selected = selectedEntries();
  const items = selected.slice(0, state.limit);
  const ids = items.map((e) => e.id);
  const first = painted === null;
  const shuffled = !first && (ids.length !== painted.length || ids.some((id, i) => id !== painted[i]));
  // Read off the list rather than taken from whoever called: paging in the next
  // screenful leaves the cards above it untouched and adds to the end, and that
  // is the same list whether the button or the sentinel asked for it. A flag
  // would have to survive the queue above, where it outlives the paint it was
  // meant for and flattens the next card that leaves.
  const appended = shuffled && painted.length > 0 && ids.length > painted.length
    && painted.every((id, i) => id === ids[i]);
  applyExits(new Set(ids));
  painted = ids;
  paintMore(selected.length - items.length);
  paintBadges();

  // Only arrivals, departures and reorders are worth animating. A card whose
  // text changed under you while you were typing in it should not move at all,
  // and a page appended below the fold has nothing to animate either.
  if (first || appended || !shuffled || reduceMotion.matches || !document.startViewTransition) {
    paint(items);
    return;
  }
  animating = true;
  const done = () => {
    animating = false;
    const next = queued;
    queued = false;
    if (next) render();
  };
  document.startViewTransition(() => paint(items)).finished.then(done, done);
}

/**
 * The button doubles as the scroll sentinel. Hiding it takes it out of layout,
 * which is also what stops the observer once nothing is held back.
 */
function paintMore(held) {
  el.more.classList.toggle('hidden', held <= 0);
  if (held > 0) el.more.textContent = `Show ${Math.min(PAGE, held)} more · ${held} left`;
}

function showMore() {
  if (el.more.classList.contains('hidden')) return;
  state.limit += PAGE;
  render();
}

/** A different set of entries is about to be listed, so start from page one. */
function resetPaging() {
  state.limit = PAGE;
  // Scrolled deep into the longer list, the reset would leave you past the end
  // of the shorter one, and the sentinel would pull the pages straight back in.
  if (window.scrollY > TOP_SLACK) window.scrollTo({ top: 0, behavior: 'instant' });
}

el.more.addEventListener('click', showMore);

// Reaching the end of the page asks for the next one; the margin means it is
// already painted by the time the last card clears the fold.
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) showMore();
}, { rootMargin: '600px 0px' }).observe(el.more);

// Newest first means an arrival pushes whatever you are reading down the page.
// Nothing survives the repaint for the browser to anchor to, so the card at the
// top of the reading area is measured before the swap and put back after it.

/** Scrolled this close to the head of the feed, arrivals are meant to show up. */
const TOP_SLACK = 8;

/** The topbar is sticky, so the first line you can actually read sits under it. */
function readingTop() {
  return el.topbar.getBoundingClientRect().bottom;
}

/** Several cards deep, so a repaint that drops the top one can fall back. */
function captureAnchors() {
  if (window.scrollY <= TOP_SLACK) return [];
  const top = readingTop();
  const anchors = [];
  for (const card of el.timeline.children) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom <= top) continue;
    anchors.push({ id: card.dataset.id, top: rect.top });
    if (anchors.length === 5) break;
  }
  return anchors;
}

function restoreAnchors(anchors) {
  for (const anchor of anchors) {
    const card = el.timeline.querySelector(`.card[data-id="${CSS.escape(anchor.id)}"]`);
    if (!card) continue;
    const drift = card.getBoundingClientRect().top - anchor.top;
    if (drift) window.scrollBy({ top: drift, behavior: 'instant' });
    return;
  }
}

/**
 * One card at a time is in focus: the one the middle of the reading area falls
 * on, plus whichever card you are typing in. Everything else is blurred back.
 */
function paintFocus() {
  cancelAnimationFrame(focusFrame);
  focusFrame = null;
  const cards = el.timeline.children;
  if (!cards.length) return;
  const top = readingTop();
  const line = top + (window.innerHeight - top) / 2;
  const active = document.activeElement;
  const typing = el.timeline.contains(active) ? active.closest('.card') : null;

  let centred = null;
  let nearest = Infinity;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    // A card taller than the reading area holds focus for its whole length.
    if (rect.top <= line && rect.bottom >= line) {
      centred = card;
      break;
    }
    // Scrolled past the ends of the feed the line falls on no card at all, so
    // the first or last one keeps it rather than the page going flat.
    const gap = rect.top > line ? rect.top - line : line - rect.bottom;
    if (gap < nearest) {
      nearest = gap;
      centred = card;
    }
  }

  for (const card of cards) {
    card.classList.toggle('focused', card === centred || card === typing);
  }
  el.timeline.classList.add('solo');
}

let focusFrame = null;

function scheduleFocus() {
  focusFrame ??= requestAnimationFrame(paintFocus);
}

window.addEventListener('scroll', scheduleFocus, { passive: true });
window.addEventListener('resize', scheduleFocus);

/** Set while the cards are being swapped out, so the focus that moves is ours. */
let swapping = false;

function paint(items) {
  const anchors = captureAnchors();
  // The cards are rebuilt from scratch, so every one of them starts blurred and
  // is sharpened again a few lines below. Held here, that round trip is not a
  // fade the card in front of you has to sit through on every update.
  el.timeline.classList.add('instant');

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

  swapping = true;
  el.timeline.innerHTML = items.map(cardHtml).join('');
  el.empty.classList.toggle('hidden', items.length > 0);
  observeUnread();

  if (focused) {
    const input = el.timeline.querySelector(`[data-reply-input="${CSS.escape(focused.id)}"]`);
    if (input) {
      input.focus();
      input.setSelectionRange(focused.start, focused.end);
    } else {
      // The card is no longer painted, so the field is not coming back and the
      // agent has nobody typing at it.
      disengage(focused.id);
    }
  }
  swapping = false;

  // Last, so that refocusing the reply box cannot scroll out from under you.
  restoreAnchors(anchors);

  // In this tick, so the replacement cards are already sharp when they first
  // render and the blur has nothing to fade in from.
  paintFocus();
  requestAnimationFrame(() => el.timeline.classList.remove('instant'));
}

function upsert(entry) {
  if (!entry?.id) return;
  if (!entry.readAt) state.marked.add(entry.id);
  state.entries.set(entry.id, entry);
  if (entry.status !== 'waiting') release(entry.id);
}

/** Leaving a tab clears the marks you have had the chance to look at. */
function settleMarks() {
  for (const id of state.marked) {
    if (state.entries.get(id)?.readAt !== null) state.marked.delete(id);
  }
}

/** The topbar covers the head of the feed, so a card only counts once it is clear of it. */
const SEEN_INSET = 56;

/**
 * A card counts as read once it has been on screen — no clicking through a
 * feed you are already reading. The cards are replaced wholesale on every
 * paint, so the observer is pointed at the new ones each time.
 */
const seenObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) markRead(entry.target.dataset.id);
  }
}, { rootMargin: `-${SEEN_INSET}px 0px` });

function observeUnread() {
  seenObserver.disconnect();
  // Nothing is on screen in a browser tab you are not looking at; observing
  // there would mark the whole feed read behind your back.
  if (document.visibilityState !== 'visible') return;
  for (const card of el.timeline.children) {
    if (state.entries.get(card.dataset.id)?.readAt) continue;
    seenObserver.observe(card);
    // The observer reports asynchronously and every paint disconnects it, so
    // on a moving feed a card can be swapped out before it is ever reported.
    // What is already in the reading area is measured here rather than waited
    // for; the observer is left to handle scrolling.
    const rect = card.getBoundingClientRect();
    if (rect.bottom > SEEN_INSET && rect.top < window.innerHeight - SEEN_INSET) {
      markRead(card.dataset.id);
    }
  }
}

document.addEventListener('visibilitychange', observeUnread);

let readTimer = null;

function markRead(id) {
  const entry = state.entries.get(id);
  if (!entry || entry.readAt || state.readPending.has(id)) return;
  state.readPending.add(id);
  // A batch, so scrolling past a screenful is one request rather than twenty.
  if (readTimer) return;
  readTimer = setTimeout(flushRead, 500);
}

/**
 * Everything the badge is counting for this tab, taken as read in one go.
 * Same set the badge counts, filters and all, so the number it clears is the
 * number you clicked.
 */
function markViewRead(view) {
  for (const entry of state.entries.values()) {
    if (entry.readAt || entry.bucket !== view || !passesFilters(entry)) continue;
    state.readPending.add(entry.id);
  }
  flushRead();
}

async function flushRead() {
  clearTimeout(readTimer);
  readTimer = null;
  const ids = [...state.readPending];
  state.readPending.clear();
  if (!ids.length) return;
  let marked;
  try {
    ({ marked } = await api('/api/entries/read', { ids }));
  } catch {
    // Nothing was marked. The cards are not guaranteed another paint, so hold
    // on to the ids instead of waiting to be shown them again.
    for (const id of ids) state.readPending.add(id);
    clearTimeout(readTimer);
    readTimer = setTimeout(flushRead, 5000);
    return;
  }
  // The same stamps arrive over SSE, but the badge should not need the stream
  // to be up to come down.
  const at = new Date().toISOString();
  let changed = false;
  for (const id of marked || []) {
    const entry = state.entries.get(id);
    if (entry && !entry.readAt) {
      entry.readAt = at;
      changed = true;
    }
  }
  if (changed) render();
}

/** The entry can no longer take a reply — drop the draft and stop holding it. */
function release(id) {
  state.drafts.delete(id);
  state.engaged.delete(id);
  firing.delete(`${id}:send`);
  firing.delete(`${id}:dismiss`);
  stopHoldHeartbeat(id);
}

async function refresh() {
  // Fetch every tab's entries; the client filters by tab so an SSE update that
  // moves a card between tabs still lands somewhere.
  const data = await fetch('/api/entries?view=all').then((r) => r.json());
  if (data.serverTime) state.serverSkew = data.serverTime - Date.now();
  state.entries.clear();
  for (const e of data.entries || []) upsert(e);
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

/** Nobody is typing at this entry any more, so stop holding its agent open. */
function disengage(id) {
  if (state.drafts.get(id)) return; // keep holding while a draft is standing
  state.engaged.delete(id);
  stopHoldHeartbeat(id);
}

// Whatever you click into keeps its card sharp, wherever it sits on the page.
el.timeline.addEventListener('focusin', scheduleFocus);
el.timeline.addEventListener('focusout', scheduleFocus);

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
  // A repaint takes the field out from under the caret and puts it straight
  // back, and that round trip is not you walking away from the entry. Left to
  // count, it stops the heartbeat and starts it again, and the beat it fires on
  // the way back is itself an update — the feed then repaints as fast as the
  // server can answer.
  if (!id || swapping) return;
  disengage(id);
});

el.timeline.addEventListener('input', (e) => {
  const id = e.target.getAttribute?.('data-reply-input');
  if (!id) return;
  state.drafts.set(id, e.target.value);
});

/**
 * Fills in the button an action came from. Lit from here rather than from the
 * click, so the keyboard shortcut lights the same button a mouse would.
 */
function light(id, act) {
  firing.add(`${id}:${act}`);
  const btn = el.timeline.querySelector(`[data-act="${act}"][data-id="${CSS.escape(id)}"]`);
  btn?.classList.add('firing');
  return btn;
}

function unlight(id, act) {
  firing.delete(`${id}:${act}`);
  el.timeline.querySelector(`[data-act="${act}"][data-id="${CSS.escape(id)}"]`)?.classList.remove('firing');
}

/** Reply and slide the card right — same path for the button and Ctrl/Cmd+Enter. */
async function sendReply(id) {
  const input = el.timeline.querySelector(`[data-reply-input="${CSS.escape(id)}"]`);
  const message = input?.value?.trim();
  if (!message) {
    input?.focus();
    return;
  }
  // Leave the field for the button, where a click has already put the focus.
  // Blurring to nothing would do as much for paint, which then has no caret to
  // restore, but it also takes the focus off the card — and a card that is not
  // the one in the middle of the reading area is blurred back the moment it
  // loses that, so the keyboard would send it out of the feed faded and a click
  // would not.
  const btn = light(id, 'send');
  if (btn) btn.focus({ preventScroll: true });
  else input?.blur();
  exits.set(id, 'right');
  try {
    await api(`/api/entries/${id}/reply`, { message });
    release(id);
    await refresh();
  } catch (err) {
    unlight(id, 'send');
    exits.delete(id);
    throw err;
  }
}

async function dismissEntry(id) {
  light(id, 'dismiss');
  exits.set(id, 'left');
  try {
    await api(`/api/entries/${id}/dismiss`);
    release(id);
    await refresh();
  } catch (err) {
    unlight(id, 'dismiss');
    exits.delete(id);
    throw err;
  }
}

el.timeline.addEventListener('keydown', (e) => {
  const id = e.target.getAttribute?.('data-reply-input');
  if (!id) return;
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  sendReply(id).catch((err) => alert(err.message || String(err)));
});

/**
 * Opens `url` in the viewer. Arrow keys walk every image on screen, not just
 * the card that was clicked, so `from` says which thumbnail was the way in —
 * two refs with the same bytes share one url and can't be told apart by it.
 */
function openImage(url, cap, from) {
  const buttons = [...el.timeline.querySelectorAll('[data-img]')];
  const items = buttons.map((b) => ({ url: b.dataset.img, cap: b.dataset.cap }));
  let index = from ? buttons.indexOf(from) : items.findIndex((it) => it.url === url);
  if (index < 0) {
    items.unshift({ url, cap });
    index = 0;
  }
  openLightbox(items, index);
}

el.timeline.addEventListener('click', async (e) => {
  const imgLink = e.target.closest('[data-img-open]');
  if (imgLink) {
    // A modified click keeps the href, so the file can still be opened raw.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openImage(imgLink.dataset.imgOpen, imgLink.dataset.cap);
    return;
  }

  const imgBtn = e.target.closest('[data-img]');
  if (imgBtn) {
    openImage(imgBtn.dataset.img, imgBtn.dataset.cap, imgBtn);
    return;
  }

  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;

  try {
    if (act === 'send') {
      await sendReply(id);
      return;
    }
    if (act === 'dismiss') {
      await dismissEntry(id);
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
  // Marking a screenful read updates a screenful of entries, so the repaint
  // waits for the whole burst instead of running once per event.
  let queued = false;
  const onEntry = (ev) => {
    try {
      upsert(JSON.parse(ev.data));
    } catch {
      return;
    }
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
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
