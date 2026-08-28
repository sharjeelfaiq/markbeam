/*
 * Shareable links.
 *
 * The document travels in the URL **fragment**, never the query. A fragment is not sent to
 * the server, so "share without a server" is literally true rather than merely true of the
 * host we happen to use — and the text never lands in an access log.
 *
 * Compression is native. `fflate` and `pako` are both in `node_modules`, but only
 * transitively, and this project does not build on a transitive dependency. Promoting one
 * would add bundle weight for a feature most sessions never touch, whereas
 * `CompressionStream` costs nothing at all.
 */

const FRAGMENT_KEY = 'doc';
const FORMAT_VERSION = 1;

/** Leading flag so the decoder never has to guess how the payload was packed. */
const CODEC_DEFLATE = 'z';
const CODEC_PLAIN = 'p';

/** Long enough that browsers cope but chat and mail clients may not. */
export const LONG_LINK = 8000;

let supportsCompression = () =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

let bytesToBase64Url = (bytes) => {
  let binary = '';
  // A spread would blow the argument limit on a large document.
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

let base64UrlToBytes = (value) => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

let pipeThrough = async (bytes, stream) => {
  const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
};

/** `{ title, text }` -> a base64url payload. */
export const encodeDocument = async ({ title, text }) => {
  const json = JSON.stringify({ v: FORMAT_VERSION, t: title || 'Untitled', c: text || '' });
  const bytes = new TextEncoder().encode(json);

  if (!supportsCompression()) {
    // A longer link beats a broken feature.
    return CODEC_PLAIN + bytesToBase64Url(bytes);
  }

  const packed = await pipeThrough(bytes, new CompressionStream('deflate-raw'));
  return CODEC_DEFLATE + bytesToBase64Url(packed);
};

/** A payload -> `{ title, text }`, or null if it is not ours to read. */
export const decodeDocument = async (payload) => {
  if (typeof payload !== 'string' || payload.length < 2) {
    return null;
  }

  try {
    const codec = payload[0];
    const bytes = base64UrlToBytes(payload.slice(1));

    let json;
    if (codec === CODEC_DEFLATE) {
      if (!supportsCompression()) {
        return null;
      }
      json = new TextDecoder().decode(
        await pipeThrough(bytes, new DecompressionStream('deflate-raw'))
      );
    } else if (codec === CODEC_PLAIN) {
      json = new TextDecoder().decode(bytes);
    } else {
      return null;
    }

    const parsed = JSON.parse(json);
    if (!parsed || parsed.v !== FORMAT_VERSION || typeof parsed.c !== 'string') {
      return null;
    }

    return { title: typeof parsed.t === 'string' ? parsed.t : 'Untitled', text: parsed.c };
  } catch (error) {
    // Truncated by a chat client, hand-edited, or simply somebody else's fragment.
    return null;
  }
};

export const buildShareUrl = async ({ title, text }) => {
  const payload = await encodeDocument({ title, text });
  const url = new URL(window.location.href);

  // Any existing fragment is ours to replace, and the query is left alone entirely.
  url.hash = `${FRAGMENT_KEY}=${payload}`;
  return url.toString();
};

/** The payload currently in the address bar, if there is one. */
export const readSharedPayload = () => {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.startsWith(`${FRAGMENT_KEY}=`)) {
    return null;
  }
  return hash.slice(FRAGMENT_KEY.length + 1) || null;
};

/*
 * Drop the fragment once it has been imported, so a reload does not import the same
 * document again and again. `replaceState` rather than assigning `location.hash`, which
 * would leave `#` behind and add a history entry.
 */
export const clearSharedFragment = () => {
  const url = new URL(window.location.href);
  url.hash = '';
  window.history.replaceState(null, '', url.pathname + url.search);
};
