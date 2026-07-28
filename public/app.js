import { parseFileRef, fileRefLink } from '/deeplink.mjs';

/** Cards painted per page. Scrolling to the end adds another page. */
const PAGE = 20;

const state = {
  view: 'timeline',
  limit: PAGE,
  entries: new Map(),
  drafts: new Map(),
  engaged: new Set(),
  holdTimers: new Map(),
  serverSkew: 0,
};

const el = {
  topbar: document.querySelector('.topbar'),
  timeline: document.getElementById('timeline'),
  empty: document.getElementById('empty'),
  conn: document.getElementById('conn'),
  history: document.getElementById('history'),
  more: document.getElementById('more'),
  lightbox: document.getElementById('lightbox'),
  lightboxStage: document.getElementById('lightbox-stage'),
  lightboxImg: document.getElementById('lightbox-img'),
  lightboxCap: document.getElementById('lightbox-cap'),
  lightboxRaw: document.getElementById('lightbox-raw'),
  themeToggle: document.getElementById('theme-toggle'),
  help: document.getElementById('help'),
  helpModal: document.getElementById('help-modal'),
  helpClose: document.getElementById('help-close'),
  helpUrl: document.getElementById('help-url'),
};

const systemTheme = window.matchMedia('(prefers-color-scheme: light)');

function currentTheme() {
  return document.documentElement.dataset.theme
    || (systemTheme.matches ? 'light' : 'dark');
}

// Lucide, inlined: the app has no dependencies and no build step to pull an
// icon set through.
const ICON = {
  moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />',
  sun: '<circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />',
};

function paintThemeToggle() {
  const theme = currentTheme();
  const label = `switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
  el.themeToggle.innerHTML =
    `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${theme === 'dark' ? ICON.moon : ICON.sun}</svg>`;
  el.themeToggle.title = label;
  el.themeToggle.setAttribute('aria-label', label);
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

/** The screen the History button leads to, which is the one you are not on. */
function otherView() {
  return state.view === 'timeline' ? 'archive' : 'timeline';
}

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  el.history.setAttribute('aria-pressed', String(view === 'archive'));
  // The icon says neither, so the name has to carry where the button leads.
  el.history.title = view === 'archive' ? 'back to the timeline' : 'past entries';
  el.history.setAttribute('aria-label', el.history.title);
  resetPaging();
  refresh();
}

el.history.addEventListener('click', () => setView(otherView()));

/**
 * An empty feed with the server running looks the same as one whose hooks were
 * never installed, so the commands that install them are a click away from
 * every screen.
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

// The address this page was reached at is the one an agent on another machine
// has to send to — except a loopback one, which is nobody's address but yours,
// and there the example from the README says more than it would.
el.helpUrl.textContent = `npm run install-hooks -- --url ${
  LOOPBACK.test(location.hostname) ? 'http://192.168.1.10:4477' : location.origin}`;

// The chord takes either key, so the one listed is the one on the keyboard in
// front of you rather than both with a slash between them.
document.getElementById('key-mod').textContent =
  /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || '') ? '⌘' : 'Ctrl';

function helpOpen() {
  return !el.helpModal.classList.contains('hidden');
}

function openHelp() {
  el.helpModal.classList.remove('hidden');
  el.helpClose.focus();
}

function closeHelp() {
  if (!helpOpen()) return;
  el.helpModal.classList.add('hidden');
  el.help.focus();
}

el.help.addEventListener('click', () => (helpOpen() ? closeHelp() : openHelp()));
el.helpClose.addEventListener('click', closeHelp);

el.helpModal.addEventListener('click', async (e) => {
  // Outside the panel is outside the dialog, the same way it is on the viewer.
  if (e.target === el.helpModal) {
    closeHelp();
    return;
  }
  const btn = e.target.closest('[data-copy-cmd]');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.parentElement.querySelector('code').textContent);
    btn.textContent = 'copied';
    setTimeout(() => { btn.textContent = 'copy'; }, 1200);
  } catch (err) {
    alert(err.message || String(err));
  }
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
    // Topmost first: whatever is over the page is what Escape is aimed at.
    if (helpOpen()) {
      closeHelp();
      return;
    }
    if (!el.lightbox.classList.contains('hidden')) {
      closeLightbox();
      return;
    }
    // The × on the button is the way back, and this is the same door.
    if (state.view === 'archive' && !typingInto(e.target)) setView('timeline');
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

/** When the message came in, in local time. Same shape on every card. */
function fmtStamp(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const date = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  return `${date}T${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}`;
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
 * telling you its card is urgent. A service that owns a colour is named onto
 * one instead of hashing into it — there is no counting on a hash to land
 * somewhere recognisable.
 */
const SERVICE_HUE = { gmail: 29, gcal: 260, gtasks: 148 };

function repoTones(key) {
  if (!key) return null;
  let hue = SERVICE_HUE[key];
  if (hue === undefined) {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    hue = 55 + (Math.abs(hash) % 290);
  }
  const tone = `var(--tone-l) var(--tone-c) ${hue}`;
  return {
    color: `oklch(${tone})`,
    line: `oklch(${tone} / 0.5)`,
    tint: `oklch(${tone} / 0.12)`,
    wash: `oklch(${tone} / 0.05)`,
  };
}

function selectedEntries() {
  const items = [...state.entries.values()]
    .filter((e) => e.bucket === state.view);
  items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return items;
}

/**
 * What the turn was run with. No card is picked or skipped over its model, so
 * it stays off the head and hangs on the badge that already names the agent —
 * one labelled line per setting, for when you do go looking.
 */
function modelTitle(entry) {
  const m = entry.model || {};
  const lines = [];
  const add = (name, value) => value && lines.push(`${name}: ${value}`);

  add('model', m.label || m.id);
  add('effort', m.effort);
  add('permission', m.permissionMode);
  add('agent type', m.agentType);
  for (const p of m.params || []) {
    if (!p.id) continue;
    if (p.id === 'effort' && m.effort) continue;
    add(p.id, p.value);
  }
  return lines.join('\n');
}

/**
 * What the session had running at the moment it stopped, so the line says that
 * and not that they are running now — by the time the card is read they may all
 * have finished, and there is nothing here that would know. Each task says what
 * it was started to do, which is the part worth showing; the count is only there
 * to say how many of them the sentences cover.
 */
function taskChip(entry) {
  const n = entry.backgroundTaskCount;
  if (!(n > 0)) return '';
  const said = entry.backgroundTasks || [];
  const title = 'Running in the session when the turn stopped';
  // One of them is a sentence, and a sentence with a number in front of it reads
  // as one line. More than one is a list, and a list wants something over it
  // saying how long it is.
  if (n === 1) {
    return `<span class="chip tasks" title="${esc(title)}">${esc(said[0] ? `background task: ${said[0]}` : 'background task')}</span>`;
  }
  const head = `<span class="chip tasks" title="${esc(title)}">${n} background tasks</span>`;
  return head + said.map((s) => `<span class="chip tasks task-line">${esc(s)}</span>`).join('');
}

/** Coarser than a hold: nothing here is decided in the last thirty seconds. */
function fmtLead(ms) {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
}

function leadClass(ms) {
  let cls = 'chip hold';
  if (ms <= 5 * 60_000) cls += ' critical';
  else if (ms <= 15 * 60_000) cls += ' low';
  return cls;
}

/**
 * A calendar card is worth reading for one thing — how long you have — so the
 * gap to the event takes the place a countdown already has, and reddens on the
 * same run in. Once the event has begun there is nothing left to be early for,
 * and it stops in the dashes the page draws around anything no longer live.
 */
function startsChip(entry) {
  const cal = entry.calendar;
  if (!cal) return '';
  const remain = cal.startMs - nowMs();
  if (remain <= 0) return '<span class="chip closed">started</span>';
  return `<span class="${leadClass(remain)}" data-starts="${esc(entry.id)}">${fmtLead(remain)}</span>`;
}

/**
 * A task has a due date and no hour, so there is nothing to count down to. How
 * far past its date it has got is the one thing worth the space, and it takes
 * the same reddening run as a meeting closing in.
 */
function dueChip(entry) {
  const todo = entry.todo;
  if (!todo) return '';
  const late = todo.overdueDays || 0;
  if (!late) return '<span class="chip hold">due today</span>';
  const cls = late >= 7 ? 'chip hold critical' : 'chip hold low';
  return `<span class="${cls}">${late}d overdue</span>`;
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

/**
 * A url someone pasted rather than wrote a label for. It ends where the
 * sentence around it resumes: punctuation that trails it goes back to the
 * prose, and so does a closing bracket the url never opened, so a link dropped
 * inside parens or 「」 stays a link and the brackets stay brackets. The `*` and
 * `_` that close emphasis go back too — a url is what a bolded line points at
 * often enough that eating the `**` would be the common case, and a url that
 * really ends in one is not.
 *
 * The text is escaped by the time it gets here, so `&` starts an entity unless
 * it spells one out — that is what keeps a quoted url from eating its quote
 * while a query string keeps its `&`.
 *
 * Code is where these actually turn up — an agent hands back the address it
 * just served on, in backticks or in the block it printed. So this runs inside
 * code too, and takes `protect` only where there is emphasis left to hide from.
 */
function autolink(s, protect = (html) => html) {
  return s.replace(/https?:\/\/(?:&amp;|[^\s&\0])+/g, (m) => {
    let url = m;
    let trail = '';
    while (url.length > 'https://'.length) {
      const last = url.slice(-1);
      const closer = last === ')' && count(url, ')') > count(url, '(');
      if (!closer && !'.,;:!?、。」』）]*_'.includes(last)) break;
      trail = last + trail;
      url = url.slice(0, -1);
    }
    return protect(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + trail;
  });
}

function count(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
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

  let out = s.replace(/`([^`]+?)`/g, (_m, code) => protect(`<code>${autolink(code)}</code>`));
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

  out = autolink(out, protect);

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
      out.push(`<pre class="md-code"><code${lang}>${autolink(codeLines.join('\n'))}</code></pre>`);
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
 * What a card wants done about it, said in the one place worth looking for it:
 * the top of the action row, directly above the box you would type the answer
 * into. The cards answered back in the session have no box, and their line
 * lands in that same place rather than up among the labels. Where the session
 * is showing — a terminal, an editor panel — is not something this page knows,
 * so the line names the action and leaves the window to you.
 */
const SESSION_CUE = {
  ask_user_question: 'answer',
  exit_plan_mode: 'approve',
};

function cueHtml(entry) {
  const hold = holdChip(entry);
  if (hold) return `<div class="cue">${hold}</div>`;
  const verb = SESSION_CUE[entry.notificationType];
  if (!verb) return '';
  return `<div class="cue"><span class="chip act">${verb}</span><span>in the session</span></div>`;
}

/**
 * `id:act` for every button that has fired and is still waiting on the server.
 * Held here rather than on the element so a re-render mid-flight repaints it lit.
 */
const firing = new Set();

/**
 * Whether there is anywhere on this card to type. An agent card takes a reply
 * while it is being held; a mail card takes one until it has been answered or
 * archived, because the person it would reach is not waiting on a socket.
 */
function takesReply(entry) {
  if (entry.status === 'waiting') return true;
  return Boolean(entry.mail) && entry.status === 'notice';
}

function actionsHtml(entry) {
  const links = entry.links || {};
  const parts = [];
  const lit = (act) => (firing.has(`${entry.id}:${act}`) ? ' firing' : '');

  if (entry.status === 'waiting') {
    parts.push(`<button type="button" class="btn primary${lit('send')}" data-act="send" data-id="${esc(entry.id)}" title="Reply">Radio in</button>`);
    parts.push(`<button type="button" class="btn danger${lit('dismiss')}" data-act="dismiss" data-id="${esc(entry.id)}" title="Archive">Box</button>`);
  } else if (entry.mail && entry.status === 'notice') {
    // Both of these take the message out of the inbox; the only question the
    // card asks is whether an answer goes with it.
    parts.push(`<button type="button" class="btn primary${lit('send')}" data-act="send" data-id="${esc(entry.id)}" title="Send the reply and archive in Gmail">Radio in</button>`);
    parts.push(`<button type="button" class="btn danger${lit('dismiss')}" data-act="dismiss" data-id="${esc(entry.id)}" title="Archive in Gmail">Box</button>`);
  } else if (entry.todo && entry.status === 'notice') {
    // The only card on the feed that can change something outside pitwall, so
    // it says what it does to the task and Box is left meaning what it means
    // everywhere else — off the feed, and nothing more.
    parts.push(`<button type="button" class="btn primary${lit('complete')}" data-act="complete" data-id="${esc(entry.id)}" title="Complete in Google Tasks">Chequered</button>`);
    parts.push(`<button type="button" class="btn danger${lit('dismiss')}" data-act="dismiss" data-id="${esc(entry.id)}" title="Archive, leaving the task open">Box</button>`);
  } else if (entry.bucket === 'timeline') {
    // A notice and a closed card both sit here with nothing to answer, so the
    // one button is the whole card. Same button as the one beside a reply, and
    // it does the same thing to the card, so it fills with the same colour on
    // the way out.
    parts.push(`<button type="button" class="btn danger${lit('dismiss')}" data-act="dismiss" data-id="${esc(entry.id)}" title="Archive">Box</button>`);
  }

  // Neither of these does anything to the card, so they go to the far end of
  // the row, away from the two that do.
  if (links.openWorkspace) {
    parts.push(`<a class="btn quiet" href="${esc(links.openWorkspace)}">Open in Cursor</a>`);
  }
  if (links.resumeCommand) {
    parts.push(`<button type="button" class="btn quiet" data-act="copy" data-copy="${esc(links.resumeCommand)}">Copy resume cmd</button>`);
  }
  // Out of the feed and into Gmail, so it opens beside the timeline rather
  // than over it. Stays on the card once it is boxed, which is when going and
  // looking at the thread is most of what is left to do with it.
  if (entry.mail?.webUrl) {
    parts.push(`<a class="btn quiet" href="${esc(entry.mail.webUrl)}" target="_blank" rel="noopener noreferrer">Open in Gmail</a>`);
  }

  let composer = '';
  if (takesReply(entry)) {
    const placeholder = entry.mail
      ? 'Reply goes out through Gmail…'
      : 'Reply goes back into the same agent turn…';
    composer = `
      <div class="composer" data-composer="${esc(entry.id)}">
        <textarea placeholder="${placeholder}" data-reply-input="${esc(entry.id)}">${esc(state.drafts.get(entry.id) || '')}</textarea>
      </div>`;
  }

  let trailer = '';
  if (entry.reply) {
    trailer = `<p class="meta replied">replied: ${esc(entry.reply)}</p>`;
  }

  return `<div class="card-actions">${cueHtml(entry)}${composer}${parts.join('')}${trailer}</div>`;
}

function cardHtml(entry) {
  const repo = entry.repo || {};
  const branch = repo.branch ? `<span class="branch">@${esc(repo.branch)}</span>` : '';
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
  return `
    <article class="card" data-id="${esc(entry.id)}" data-agent="${esc(entry.agent)}" data-status="${esc(entry.status)}"${style}>
      <div class="card-head">
        <div class="head-line">
          <span class="repo">${esc(repo.name || 'unknown')}${branch}</span>
          <span class="badge ${esc(entry.agent)}" title="${esc(modelTitle(entry))}">${esc(entry.agent)}</span>
          <span class="meta stamp" title="${esc(entry.createdAt)}">${fmtStamp(entry.createdAt)}</span>
          ${startsChip(entry)}${dueChip(entry)}
        </div>
        <div class="chips">${taskChip(entry)}</div>
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
 * The card you last clicked, until it leaves the screen. A long card holds the
 * middle of the reading area for its whole length, and a short one below it can
 * be fully in view the whole time without ever reaching the middle, so pointing
 * at a card has to be able to say what the scroll position cannot.
 */
let picked = null;

/**
 * The card a keyboard shortcut lands on. Two cards can be sharp at once — the
 * one you are reading and the one you are typing in — and only the first of
 * those is the one you mean when your hands are off the text.
 */
let sharpId = null;

/**
 * One card at a time is in focus: the one you picked, or failing that the one
 * the middle of the reading area falls on, plus whichever card you are typing
 * in. Everything else is blurred back.
 */
function paintFocus() {
  cancelAnimationFrame(focusFrame);
  focusFrame = null;
  const cards = el.timeline.children;
  if (!cards.length) {
    sharpId = null;
    return;
  }
  const top = readingTop();
  const line = top + (window.innerHeight - top) / 2;
  const active = document.activeElement;
  const typing = el.timeline.contains(active) ? active.closest('.card') : null;

  let pick = null;
  let centred = null;
  let closest = null;
  let nearest = Infinity;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    // Scrolled out of the reading area, the card you picked has had its turn.
    if (card.dataset.id === picked && rect.bottom > top && rect.top < window.innerHeight) {
      pick = card;
    }
    if (centred) continue;
    // A card taller than the reading area holds focus for its whole length.
    if (rect.top <= line && rect.bottom >= line) {
      centred = card;
      continue;
    }
    // Scrolled past the ends of the feed the line falls on no card at all, so
    // the first or last one keeps it rather than the page going flat.
    const gap = rect.top > line ? rect.top - line : line - rect.bottom;
    if (gap < nearest) {
      nearest = gap;
      closest = card;
    }
  }
  picked = pick?.dataset.id ?? null;

  const sharp = pick || centred || closest;
  sharpId = sharp?.dataset.id ?? null;
  for (const card of cards) {
    card.classList.toggle('focused', card === sharp || card === typing);
  }
  // One at a time is right for the timeline, where the next card down might be
  // waiting on you and the blur is what keeps you from reading ahead. The
  // archive is over — you scan it, so nothing there is pushed out of focus.
  el.timeline.classList.toggle('solo', state.view === 'timeline');
}

// Reading is pointing: whatever you click is what you are on, wherever the
// scroll position happens to have left the middle of the page.
el.timeline.addEventListener('pointerdown', (e) => {
  const card = e.target.closest?.('.card');
  if (!card) return;
  picked = card.dataset.id;
  paintFocus();
});

/**
 * The card you were on is leaving, so the one next to it takes over. Left to
 * the middle of the reading area, a run of short cards puts the focus several
 * entries from the one you just boxed — near the middle of the screen, but
 * nowhere near where you were working.
 */
function handOff(staying) {
  if (!sharpId || staying.has(sharpId)) return;
  const cards = [...el.timeline.children];
  const at = cards.findIndex((card) => card.dataset.id === sharpId);
  if (at < 0) return;
  // Down first: that is the card moving up into the space the one you closed
  // leaves. Off the end of the feed there is only the one above.
  const below = cards.slice(at + 1).find((card) => staying.has(card.dataset.id));
  const above = cards.slice(0, at).reverse().find((card) => staying.has(card.dataset.id));
  const next = below || above;
  if (next) picked = next.dataset.id;
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
  // While the old cards are still up, so the one you were on still has sides.
  handOff(new Set(items.map((entry) => entry.id)));

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

  // The fields are new elements, so a draft carried across the swap is back at
  // one line's worth of height until it is measured again. Before the anchors
  // go back, so the heights are settled by the time the scroll is restored.
  el.timeline.querySelectorAll('[data-reply-input]').forEach(grow);

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
  state.entries.set(entry.id, entry);
  // A mail card sits at `notice` for as long as it is answerable, so releasing
  // on anything but `waiting` would wipe the draft on every poll.
  if (!takesReply(entry)) release(entry.id);
}

/** The entry can no longer take a reply — drop the draft and stop holding it. */
function release(id) {
  state.drafts.delete(id);
  state.engaged.delete(id);
  firing.delete(`${id}:send`);
  firing.delete(`${id}:dismiss`);
  firing.delete(`${id}:complete`);
  stopHoldHeartbeat(id);
}

async function refresh() {
  // Fetch both screens' entries; the client picks between them, so an SSE
  // update that moves a card from one to the other still lands somewhere.
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
  // There is an agent behind a waiting card and nothing behind a mail one, so
  // typing into mail has nothing to hold open and nothing to tell.
  if (state.entries.get(id)?.status !== 'waiting') return;
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

/**
 * Sets the box to the height of what is in it, so a reply that runs to several
 * lines is on screen whole. Measured from nothing first, so it comes back down
 * as well as up, and the borders are added back because the box is border-box
 * and scrollHeight is not. Past the cap in the stylesheet it scrolls instead.
 */
function grow(box) {
  box.style.height = 'auto';
  box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
}

el.timeline.addEventListener('input', (e) => {
  const id = e.target.getAttribute?.('data-reply-input');
  if (!id) return;
  state.drafts.set(id, e.target.value);
  grow(e.target);
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

/** Tick the task off in Google, and slide the card out the way a reply does. */
async function completeTask(id) {
  light(id, 'complete');
  exits.set(id, 'right');
  try {
    await api(`/api/entries/${id}/complete`);
    release(id);
    await refresh();
  } catch (err) {
    unlight(id, 'complete');
    exits.delete(id);
    throw err;
  }
}

el.timeline.addEventListener('keydown', (e) => {
  const id = e.target.getAttribute?.('data-reply-input');
  if (!id) return;
  // The key under the finger, not what it produced. Mid-conversion an IME takes
  // the keypress for itself and hands the page `Process`, so a reply typed in
  // Japanese and sent before committing the text would land on nothing at all —
  // no send, no card leaving, nothing to tell you the chord had missed. Plain
  // Enter is the one an IME really is claiming, and it is already not the chord.
  const enter = e.code === 'Enter' || e.code === 'NumpadEnter' || e.key === 'Enter';
  if (!enter || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  sendReply(id).catch((err) => alert(err.message || String(err)));
});

/** Anywhere a keystroke is a letter you meant to type rather than a command. */
function typingInto(node) {
  const tag = node?.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || node?.isContentEditable === true;
}

/**
 * B boxes the card you are on. Off while the caret is in a field, where the
 * Ctrl/Cmd+Enter above is the only key that means anything, and off while the
 * viewer is up, where the card behind it is not what you are looking at.
 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'b' && e.key !== 'B') return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (typingInto(e.target)) return;
  if (!el.lightbox.classList.contains('hidden') || helpOpen()) return;
  if (!sharpId) return;
  // The button is the whole rule for whether a card can be boxed, so ask it
  // rather than repeating the statuses it is drawn for.
  const btn = el.timeline.querySelector(`[data-act="dismiss"][data-id="${CSS.escape(sharpId)}"]`);
  if (!btn || firing.has(`${sharpId}:dismiss`)) return;
  e.preventDefault();
  dismissEntry(sharpId).catch((err) => alert(err.message || String(err)));
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
    if (act === 'complete') {
      await completeTask(id);
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
  for (const chip of el.timeline.querySelectorAll('[data-starts]')) {
    const entry = state.entries.get(chip.getAttribute('data-starts'));
    if (!entry?.calendar) continue;
    const remain = entry.calendar.startMs - nowMs();
    if (remain <= 0) {
      chip.removeAttribute('data-starts');
      chip.className = 'chip closed';
      chip.textContent = 'started';
      continue;
    }
    chip.className = leadClass(remain);
    chip.textContent = fmtLead(remain);
  }
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
}, 1000);

function setConn(ok) {
  el.conn.hidden = ok;
  el.conn.title = ok ? '' : 'the live feed dropped — retrying';
}

function connectSse() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.serverTime) state.serverSkew = data.serverTime - Date.now();
    } catch { /* ignore */ }
    setConn(true);
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
  es.onerror = () => setConn(false);
}

refresh().catch((err) => {
  setConn(false);
  el.empty.textContent = `Failed to load: ${err.message}`;
  el.empty.classList.remove('hidden');
});
connectSse();
