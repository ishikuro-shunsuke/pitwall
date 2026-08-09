/**
 * Neither Cursor nor Claude Code exposes a deeplink that focuses one specific
 * conversation, so the best available jump target is the workspace itself: the
 * editor routes the URL to the window that already has that folder open.
 */

function encodePath(absolutePath) {
  return absolutePath.split('/').map(encodeURIComponent).join('/');
}

/**
 * A path read inside a container names a filesystem the editor cannot reach:
 * /workspaces/x exists nowhere else. Both ends of the mount come from the
 * devcontainer itself, and without them the click has nowhere to land.
 */
function hostSidePath(normalized, { container, containerRoot, hostRoot } = {}) {
  if (!container) return normalized;
  if (!containerRoot || !hostRoot) return null;
  const from = containerRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized !== from && !normalized.startsWith(`${from}/`)) return null;
  return `${hostRoot.replace(/\\/g, '/').replace(/\/+$/, '')}${normalized.slice(from.length)}`;
}

/**
 * WSL matters here. `cursor://file//home/me/x` is resolved against the Windows
 * filesystem, so a path that lives inside a distro has to be addressed through
 * the remote authority instead.
 */
export function fileLink(absolutePath, host = {}) {
  if (!absolutePath) return null;
  const normalized = hostSidePath(absolutePath.replace(/\\/g, '/'), host);
  if (!normalized) return null;
  const { wslDistro } = host;

  if (wslDistro) {
    const withoutLeadingSlash = normalized.replace(/^\/+/, '');
    return `cursor://vscode-remote/wsl+${encodeURIComponent(wslDistro)}/${encodePath(withoutLeadingSlash)}`;
  }

  if (/^[A-Za-z]:/.test(normalized)) {
    return `cursor://file/${normalized}`;
  }
  return `cursor://file${encodePath(normalized)}`;
}

const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/**
 * Agents write file references as workspace-relative markdown links with the
 * line in the fragment — `[app.js:42](public/app.js#L42)`. Anything carrying a
 * scheme, or pointing at nothing but an anchor, belongs to somebody else.
 */
export function parseFileRef(target) {
  if (!target || SCHEME.test(target) || target.startsWith('#') || /\s/.test(target)) return null;
  const m = target.match(/^(.*?)(?:#L?(\d+)(?:-L?\d+)?|:(\d+))?$/);
  const file = m?.[1];
  if (!file) return null;
  return { path: file, line: m[2] || m[3] || null };
}

function isAbsolute(p) {
  return /^([A-Za-z]:)?[\\/]/.test(p);
}

function joinPath(root, rel) {
  const out = [];
  for (const part of `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel.replace(/\\/g, '/')}`.split('/')) {
    if (part === '.') continue;
    if (part === '..') {
      if (out.length > 1) out.pop();
      continue;
    }
    if (part === '' && out.length) continue;
    out.push(part);
  }
  return out.join('/') || '/';
}

/**
 * The repo root is the base a relative reference is written against, so the
 * resulting link lands in the same window `openWorkspace` would open.
 */
export function fileRefLink(ref, root, host) {
  if (!ref) return null;
  const absolute = isAbsolute(ref.path) ? ref.path : root && joinPath(root, ref.path);
  if (!absolute) return null;
  const link = fileLink(absolute, host);
  return link && ref.line ? `${link}:${ref.line}` : link;
}

export function promptLink(text) {
  const url = new URL('cursor://anysphere.cursor-deeplink/prompt');
  url.searchParams.set('text', text);
  return url.toString();
}

export function buildLinks(entry) {
  const host = entry.host ?? {};
  const anchor = entry.repo?.worktree || entry.repo?.root || host.cwd;
  const links = {
    openWorkspace: fileLink(anchor, host),
    newChat: null,
    resumeCommand: null,
  };

  if (entry.agent === 'claude' && entry.sessionId) {
    const dir = host.cwd || entry.repo?.worktree || entry.repo?.root || '.';
    links.resumeCommand = `cd ${quote(dir)} && claude --resume ${entry.sessionId}`;
  }
  return links;
}

function quote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
