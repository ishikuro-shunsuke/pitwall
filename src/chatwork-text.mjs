/**
 * A Chatwork message down to something a card can show.
 *
 * Chatwork's markup is neither markdown nor HTML: mentions, quotes, code and
 * files all arrive as square-bracket tags. A card renders markdown, so a tag
 * left in shows as itself — and `[To:1234567]` in front of every message is the
 * one part of it nobody reads. What comes out is what a person would say aloud.
 */
export function chatworkText(raw) {
  return String(raw || '')
    // A quote is the message being answered, carried along with the answer. On
    // a card that is the conversation shown again under what just arrived.
    .replace(/\[qt\][\s\S]*?\[\/qt\]/gi, '')
    .replace(/\[qtmeta[^\]]*\]/gi, '')
    .replace(/\[code\]([\s\S]*?)\[\/code\]/gi, (_, code) => `\n\`\`\`\n${code.trim()}\n\`\`\`\n`)
    // An info box is a heading and a body, which is a heading and a body here.
    .replace(/\[title\]([\s\S]*?)\[\/title\]/gi, (_, title) => `**${title.trim()}**\n`)
    .replace(/\[\/?info\]/gi, '\n')
    .replace(/\[hr\]/gi, '\n---\n')
    .replace(/\[toall\]/gi, '@all')
    // The name is already written out beside the tag, so the tag itself goes.
    .replace(/\[To:\d+\]\s?/gi, '')
    .replace(/\[rp\s[^\]]*\]\s?/gi, '')
    .replace(/\[picon:\d+\]\s?/gi, '')
    // A file says its name and nothing else useful; the link needs Chatwork.
    .replace(/\[download:\d+\]([\s\S]*?)\[\/download\]/gi, (_, name) => `file: ${name.trim()}`)
    .replace(/\[preview[^\]]*\]/gi, '')
    .replace(/\[\/preview\]/gi, '')
    .replace(/\[dtext:[^\]]*\]/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Long enough for a name, short enough not to be the message. */
const NAME_CHARS = 24;

/**
 * What is left once the line that addresses you is taken off the front.
 *
 * A message picked out for you almost always opens with your own name, because
 * that is how Chatwork addresses anybody, and on your own card it is the one
 * line that tells you nothing. It goes — unless the message is written on the
 * same line as the address, or is nothing but the address, in which case taking
 * the line would take the message with it.
 */
export function withoutOpeningAddress(raw) {
  const lines = String(raw || '').split('\n');
  let i = 0;
  while (i < lines.length && /^\s*\[(?:To:\d+|rp\s[^\]]*)\]/.test(lines[i])) {
    if (chatworkText(lines[i]).length > NAME_CHARS) break;
    i += 1;
  }
  const rest = lines.slice(i).join('\n').trim();
  return rest || String(raw || '');
}
