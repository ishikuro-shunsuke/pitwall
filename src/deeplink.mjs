/**
 * What a card can offer besides an answer. A path an agent writes names the
 * filesystem it ran on, which is not one this browser can open, so references
 * stay text; a Claude Code session has an id, and that is enough to write the
 * command that picks it back up.
 */

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

export function buildLinks(entry) {
  const host = entry.host ?? {};
  const links = { resumeCommand: null };

  if (entry.agent === 'claude' && entry.sessionId) {
    const dir = host.cwd || entry.repo?.worktree || entry.repo?.root || '.';
    links.resumeCommand = `cd ${quote(dir)} && claude --resume ${entry.sessionId}`;
  }
  return links;
}

function quote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
