/*
 * `:emoji:` shortcodes.
 *
 * The dataset is loaded lazily and deliberately. node-emoji indexes `emojilib`, 326 KB
 * unpacked, almost all of it search keywords this only-lookup use has no need for. Loading
 * it eagerly would put ~60–80 KB gzip on every page load whether the document contains a
 * shortcode or not, which is the cost jspdf and html2canvas-pro are already kept out of the
 * first paint to avoid. So it arrives in its own chunk after boot, and `main.js` re-renders
 * once if the open document could contain a shortcode.
 *
 * Until it arrives — and for any name the dataset does not know — the tokenizer returns
 * `undefined`. Falling through is what leaves the text exactly as written, so an unrendered
 * shortcode is always the literal source rather than a blank or a placeholder.
 */

/*
 * Deliberately narrow: lowercase, digits, `_`, `+`, `-`. That is the GitHub shortcode
 * alphabet, and it is what keeps `http://host:8080/x` intact — `/` cannot appear in a name,
 * so there is nothing to match.
 */
const SHORTCODE = /^:([a-z0-9_+-]+):/;
const SHORTCODE_START = /:[a-z0-9_+-]+:/;

let emoji = null;
let loading = null;

let lookup = (name) => {
  if (!emoji) {
    return null;
  }
  try {
    return emoji.get(name) || null;
  } catch (error) {
    // A malformed name is a miss, not a crash — the text stays literal.
    return null;
  }
};

/** Resolves to true the first time the dataset actually arrives, false thereafter. */
export const loadEmoji = () => {
  if (emoji) {
    return Promise.resolve(false);
  }

  if (!loading) {
    loading = import('node-emoji')
      .then((module) => {
        emoji = module;
        return true;
      })
      .catch(() => {
        // Offline or blocked: shortcodes simply stay literal, which is the pre-T5 behaviour.
        loading = null;
        return false;
      });
  }

  return loading;
};

export const emojiExtension = {
  name: 'emoji',
  level: 'inline',

  /*
   * Marked consumes plain text in runs, and only stops early where an extension says it
   * might match. Without this, `inlineText` would swallow the shortcode before the
   * tokenizer below ever saw it.
   */
  start(src) {
    return SHORTCODE_START.exec(src)?.index;
  },

  tokenizer(src) {
    const match = SHORTCODE.exec(src);
    if (!match) {
      return undefined;
    }

    const character = lookup(match[1]);
    if (!character) {
      return undefined;
    }

    return { type: 'emoji', raw: match[0], character };
  },

  /*
   * A bare character, with no wrapper element. It needs no escaping, it survives DOMPurify
   * untouched, and it keeps working in the two places that re-read the rendered preview —
   * copy-as-HTML and the PDF rasteriser — neither of which would carry a styled span.
   */
  renderer(token) {
    return token.character;
  }
};
