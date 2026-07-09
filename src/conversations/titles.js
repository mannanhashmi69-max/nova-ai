// Derives a short conversation title from the first user message, the way
// ChatGPT does — no prompt to the user, no extra AI call, just a clean
// truncation at a word boundary.
function generateTitle(firstMessage) {
  if (!firstMessage) return 'New conversation';

  let title = firstMessage.trim().replace(/\s+/g, ' ');
  const MAX = 48;

  if (title.length <= MAX) return title.replace(/[.?!]+$/, '');

  const cut = title.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(' ');
  title = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return title.replace(/[.?!,;:]+$/, '') + '…';
}

module.exports = { generateTitle };
