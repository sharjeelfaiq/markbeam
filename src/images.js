/*
 * Private, browser-local image preparation.
 *
 * Input bytes never leave the page. Decoding and drawing through a canvas discards source
 * metadata, caps the longest edge, and gives every accepted format the same self-contained
 * WebP representation before Markdown sees it.
 */

export const MAX_IMAGE_BYTES = 300 * 1024;
export const MAX_IMAGE_EDGE = 1600;

const SUPPORTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SUPPORTED_EXTENSION = /\.(png|jpe?g|webp)$/i;
const SVG_EXTENSION = /\.svg$/i;
const GIF_EXTENSION = /\.gif$/i;
const IMAGE_EXTENSION = /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i;

const filename = (file) => String(file?.name || '').trim() || 'image';

/**
 * Returns `supported`, `unsupported-image`, or `other`. `other` is deliberately neutral:
 * main.js hands those files to the established Markdown-opening path.
 */
export const classifyImageFile = (file) => {
  const name = filename(file);
  const mime = String(file?.type || '').toLowerCase();

  if (mime === 'image/svg+xml' || SVG_EXTENSION.test(name)) {
    return {
      kind: 'unsupported-image',
      reason: 'SVG images are not supported — use PNG, JPEG, or WebP'
    };
  }

  if (mime === 'image/gif' || GIF_EXTENSION.test(name)) {
    return {
      kind: 'unsupported-image',
      reason: 'Animated GIFs are not supported — use a static PNG, JPEG, or WebP image'
    };
  }

  if (SUPPORTED_MIMES.has(mime) || (!mime.startsWith('image/') && SUPPORTED_EXTENSION.test(name))) {
    return { kind: 'supported' };
  }

  if (mime.startsWith('image/') || IMAGE_EXTENSION.test(name)) {
    return {
      kind: 'unsupported-image',
      reason: `“${name}” uses an unsupported image format — use PNG, JPEG, or WebP`
    };
  }

  return { kind: 'other' };
};

/*
 * A clipboard image commonly arrives as `image.png`; that is browser plumbing, not useful
 * alternative text. Real filenames keep their stem, with Markdown delimiters and control
 * characters reduced to spaces so the generated image syntax cannot be broken.
 */
export const altTextFromFilename = (name) => {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^./\\]+$/, '')
    .replace(/[\u0000-\u001f\u007f\[\]<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!base || /^(?:image|img|clipboard|blob)(?:[-_ ]?\d+)?$/i.test(base)) {
    return 'Pasted image';
  }

  return base;
};

const canvasToWebp = (canvas, quality) =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob || blob.type !== 'image/webp') {
          reject(new Error('This browser could not encode the image as WebP'));
          return;
        }
        resolve(blob);
      },
      'image/webp',
      quality
    );
  });

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result), { once: true });
    reader.addEventListener('error', () => reject(new Error('Could not encode the image')), {
      once: true
    });
    reader.readAsDataURL(blob);
  });

const nextDimension = (value) => Math.max(1, Math.min(value - 1, Math.round(value * 0.82)));

/**
 * Rasterises one supported file and resolves to data ready for a Markdown edit.
 * Throws with a toast-ready message; callers process batches before editing, so a failure
 * here leaves the entire batch atomic.
 */
export const optimizeImage = async (file) => {
  const classification = classifyImageFile(file);
  if (classification.kind !== 'supported') {
    throw new Error(classification.reason || `“${filename(file)}” is not a supported image`);
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (error) {
    throw new Error(`Could not read “${filename(file)}” as an image`);
  }

  try {
    if (!bitmap.width || !bitmap.height) {
      throw new Error(`“${filename(file)}” has no usable image data`);
    }

    const initialScale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * initialScale));
    let height = Math.max(1, Math.round(bitmap.height * initialScale));
    const qualities = [0.86, 0.76, 0.66, 0.56, 0.46, 0.36];

    while (true) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: true });

      if (!context) {
        throw new Error('This browser could not process the image');
      }

      context.drawImage(bitmap, 0, 0, width, height);

      for (const quality of qualities) {
        const blob = await canvasToWebp(canvas, quality);
        if (blob.size <= MAX_IMAGE_BYTES) {
          const dataUrl = await blobToDataUrl(blob);
          const alt = altTextFromFilename(file.name);
          return {
            alt,
            bytes: blob.size,
            dataUrl,
            height,
            markdown: `![${alt}](${dataUrl})`,
            width
          };
        }
      }

      if (width === 1 && height === 1) {
        break;
      }

      width = nextDimension(width);
      height = nextDimension(height);
    }
  } finally {
    bitmap.close();
  }

  throw new Error(`“${filename(file)}” could not be reduced below 300 KiB`);
};
