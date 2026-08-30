/*
 * Searching every stored document.
 *
 * Pure: it is handed an array of `{ id, title, text }` and returns hits. No DOM, no storage,
 * no knowledge of which document is open — `main.js` assembles the corpus and decides what to
 * do with a hit, exactly as it does for the outline and the history sheet.
 *
 * The caps are the whole design. A search across every document can match thousands of times,
 * and a sheet listing thousands of rows is slower to read than opening the documents by hand.
 * Two limits apply: a per-document one so a single flooded file cannot crowd out every other
 * document's hits, and a total one so the list stays scannable. `truncated` is reported rather
 * than inferred, because a list that silently stops is indistinguishable from a complete one.
 */

export const MAX_HITS = 50;
export const MAX_HITS_PER_DOCUMENT = 10;

/** Enough context to recognise the line, without turning a row into a paragraph. */
const SNIPPET_LIMIT = 120;

/*
 * Two characters, not one. A single letter matches most of the corpus, which is slow to
 * collect and useless to read — and the sheet shows a prompt instead, so nothing looks broken.
 */
export const MIN_QUERY = 2;

let snippet = (line) => {
  const trimmed = line.trim();
  return trimmed.length > SNIPPET_LIMIT ? `${trimmed.slice(0, SNIPPET_LIMIT)}…` : trimmed;
};

/**
 * `documents` is `[{ id, title, text }]`. Returns
 * `{ term, hits, truncated }`, where each hit carries a 1-based line and column so Monaco can
 * be pointed straight at it.
 */
export const searchDocuments = (documents, query) => {
  const term = String(query || '').trim();

  if (term.length < MIN_QUERY) {
    return { term, hits: [], truncated: false, tooShort: term.length > 0 };
  }

  const needle = term.toLowerCase();
  const hits = [];
  let truncated = false;

  for (const entry of documents || []) {
    if (hits.length >= MAX_HITS) {
      truncated = true;
      break;
    }

    const lines = String(entry.text || '').split('\n');
    let inThisDocument = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const haystack = line.toLowerCase();
      let from = 0;

      for (;;) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) {
          break;
        }

        // Checked here rather than after the loop, so `truncated` only means "a real match
        // was dropped" and never "the cap happened to land exactly on the last one".
        if (hits.length >= MAX_HITS || inThisDocument >= MAX_HITS_PER_DOCUMENT) {
          truncated = true;
          break;
        }

        hits.push({
          id: entry.id,
          title: entry.title || 'Untitled',
          line: index + 1,
          column: at + 1,
          length: term.length,
          text: snippet(line)
        });

        inThisDocument += 1;
        from = at + needle.length;
      }

      if (hits.length >= MAX_HITS || inThisDocument >= MAX_HITS_PER_DOCUMENT) {
        break;
      }
    }
  }

  return { term, hits, truncated, tooShort: false };
};

/** How many documents the hits span — the sheet says this, since it is the actual question. */
export const documentsMatched = (hits) => new Set(hits.map((hit) => hit.id)).size;
