/**
 * Neither Cursor nor Claude Code exposes a deeplink that focuses one specific
 * conversation, so the best available jump target is the workspace itself: the
 * editor routes the URL to the window that already has that folder open.
 */

function encodePath(absolutePath) {
  return absolutePath.split('/').map(encodeURIComponent).join('/');
}

/**
 * WSL matters here. `cursor://file//home/me/x` is resolved against the Windows
 * filesystem, so a path that lives inside a distro has to be addressed through
 * the remote authority instead.
 */
export function fileLink(absolutePath, { wslDistro } = {}) {
  if (!absolutePath) return null;
  const normalized = absolutePath.replace(/\\/g, '/');

  if (wslDistro) {
    const withoutLeadingSlash = normalized.replace(/^\/+/, '');
    return `cursor://vscode-remote/wsl+${encodeURIComponent(wslDistro)}/${encodePath(withoutLeadingSlash)}`;
  }

  if (/^[A-Za-z]:/.test(normalized)) {
    return `cursor://file/${normalized}`;
  }
  return `cursor://file${encodePath(normalized)}`;
}

export function promptLink(text) {
  const url = new URL('cursor://anysphere.cursor-deeplink/prompt');
  url.searchParams.set('text', text);
  return url.toString();
}

export function buildLinks(entry) {
  const host = entry.host ?? {};
  const anchor = entry.repo?.root || host.cwd;
  const links = {
    openWorkspace: fileLink(anchor, host),
    openTranscript: entry.transcriptPath ? fileLink(entry.transcriptPath, host) : null,
    newChat: null,
    resumeCommand: null,
  };

  if (entry.agent === 'claude' && entry.sessionId) {
    const dir = host.cwd || entry.repo?.root || '.';
    links.resumeCommand = `cd ${quote(dir)} && claude --resume ${entry.sessionId}`;
  }
  return links;
}

function quote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
