/*
 * Heading slugs, GitHub-style.
 *
 * This reverses a decision T35 recorded on purpose: headings had no ids, because ids are "a
 * new public surface — anchor links, duplicate-slug rules, and ids leaking into exported
 * HTML". T42 needs `[TOC]` links that work, which needs targets, so the surface is now taken
 * on deliberately rather than by accident. The rules below are that surface, written down.
 *
 * **Duplicates are the whole reason this is a module rather than one regex.** Two headings
 * with the same text are ordinary in a real document — `## Notes` under two sections — and a
 * slugger that ignores that gives both the same id, so every link to the second one silently
 * goes to the first. Nothing looks broken; the link simply lies.
 */

/*
 * Lowercase, strip anything that is not a word character, space or hyphen, then collapse
 * whitespace to single hyphens. `Setup & Config` becomes `setup-config`, matching what people
 * expect from GitHub and from links they may already have written elsewhere.
 */
export const slugify = (text) =>
  String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * A slugger with memory. Call it once per heading in document order; a repeat gets `-1`,
 * `-2`, and so on, which is GitHub's rule.
 */
export const createSlugger = () => {
  const seen = new Map();

  return (text) => {
    const base = slugify(text) || 'section';
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);

    if (count === 0) {
      return base;
    }

    /*
     * A suffixed slug can itself collide — a document containing `Notes`, `Notes` and
     * `Notes 1` would otherwise produce `notes-1` twice. Keep stepping until the result is
     * genuinely unused.
     */
    let candidate = `${base}-${count}`;
    let next = count;
    while (seen.has(candidate)) {
      next += 1;
      candidate = `${base}-${next}`;
    }
    seen.set(candidate, 1);
    return candidate;
  };
};
