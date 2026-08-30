import { getTheme } from '../theme.js';
import { renderMermaidDiagrams, renderMermaidForTheme } from '../mermaid/index.js';

/*
 * PDF export.
 *
 * Two problems shape this file:
 *
 * 1. Rasterising a long document as a single canvas blows past the browser's maximum
 *    canvas size (~16384px) and silently returns a blank image. So each PDF page gets
 *    its own bounded canvas.
 * 2. html2canvas clones the entire document on *every* call, and that clone dominates
 *    the cost. One call per page made long exports quadratic — a 60-page document took
 *    over five minutes. So pages are rasterised in bands and cut apart locally.
 */

const MARGIN_MM = 10;
const PAGE_WIDTH_MM = 210 - MARGIN_MM * 2;
const PAGE_HEIGHT_MM = 297 - MARGIN_MM * 2;

/** Fixed render width, so output does not depend on where the divider sits. */
const CONTENT_WIDTH_PX = 720;
const RENDER_SCALE = 2;

/** 6000 CSS px keeps the band canvas (12000px at scale 2) well inside the ceiling. */
const MAX_BAND_PX = 6000;
const MAX_BAND_PAGES = 6;

/*
 * An offscreen, fixed-width copy of the preview, clipped to one band. Shifting the inner
 * element up by a page offset captures the document a slice at a time without the user
 * ever seeing the page move.
 */
let createSandbox = (outputElement, heightPx) => {
  const sandbox = document.createElement('div');
  sandbox.id = 'pdf-export-sandbox';
  sandbox.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    `width:${CONTENT_WIDTH_PX}px`,
    `height:${heightPx}px`,
    'overflow:hidden',
    'background:#fff',
    'pointer-events:none'
  ].join(';');

  const content = document.createElement('div');
  content.id = 'pdf-export-content';
  // Carries `markdown-body mb-md`, so the export picks up our preview typography too.
  content.className = outputElement.className;
  content.style.cssText = `width:${CONTENT_WIDTH_PX}px;background:#fff`;

  // Clone live nodes rather than round-tripping innerHTML: copies the already-rendered
  // Mermaid SVGs verbatim and re-parses nothing.
  for (const child of Array.from(outputElement.childNodes)) {
    content.appendChild(child.cloneNode(true));
  }

  sandbox.appendChild(content);
  document.body.appendChild(sandbox);

  return { sandbox, content };
};

/*
 * Replaces every Mermaid <svg> in the sandbox with an <img> of the same size.
 *
 * html2canvas rasterises an inline <svg> itself, and it draws Mermaid's output larger than
 * the box the browser laid it out in, so the right-hand side of a diagram is clipped away
 * inside the svg's own viewport. Measured on the welcome document's four-node `graph LR`:
 * the svg lays out at 458px wide and the rasteriser drew 340px of it, losing the two
 * right-hand nodes entirely.
 *
 * The DOM geometry is correct throughout — sandbox and html2canvas clone both report
 * 458x174 — so this is not a layout problem and no amount of CSS fixes it. Setting
 * explicit width/height attributes and stripping Mermaid's inline max-width changes
 * nothing either; both were measured. Handing the rasteriser a bitmap instead of an SVG
 * sidesteps its SVG path completely, and the diagram comes back whole.
 *
 * Runs before the page offsets are measured, so what is measured is what is drawn. A
 * diagram that fails to encode is left as-is: a clipped diagram beats a missing one.
 */
let rasteriseMermaidDiagrams = async (content) => {
  const diagrams = Array.from(content.querySelectorAll('.mermaid svg'));

  await Promise.all(
    diagrams.map((svg) => {
      const rect = svg.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);

      if (width <= 0 || height <= 0) {
        return Promise.resolve();
      }

      // The serialised copy is a standalone document: it needs its own size and namespace,
      // and Mermaid's inline max-width would otherwise constrain it a second time.
      const copy = svg.cloneNode(true);
      copy.setAttribute('width', String(width));
      copy.setAttribute('height', String(height));
      copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      copy.removeAttribute('style');

      const markup = new XMLSerializer().serializeToString(copy);
      const source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

      return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
          // Same box as the svg it replaces, so the offsets measured next still hold.
          image.style.cssText = `display:block;margin:0 auto;width:${width}px;height:${height}px`;
          svg.replaceWith(image);
          resolve();
        };
        image.onerror = () => resolve();
        image.src = source;
      });
    })
  );
};

/*
 * Page boundaries that land between top-level blocks, so a heading, table row or code
 * block is never sliced in half. A block taller than one page is split as a fallback.
 */
let computePageOffsets = (content, pageHeightPx) => {
  const contentTop = content.getBoundingClientRect().top;
  const offsets = [];
  let pageStart = 0;

  for (const child of Array.from(content.children)) {
    const rect = child.getBoundingClientRect();
    const top = rect.top - contentTop;
    const bottom = rect.bottom - contentTop;

    while (bottom - pageStart > pageHeightPx) {
      if (top > pageStart) {
        offsets.push(pageStart);
        pageStart = top;
        if (bottom - pageStart <= pageHeightPx) {
          break;
        }
      }

      offsets.push(pageStart);
      pageStart += pageHeightPx;
    }
  }

  offsets.push(pageStart);
  return offsets;
};

let groupPagesIntoBands = (pages) => {
  const bands = [];
  let current = null;

  for (const page of pages) {
    const fits =
      current && page.end - current.start <= MAX_BAND_PX && current.pages.length < MAX_BAND_PAGES;

    if (fits) {
      current.pages.push(page);
      current.end = page.end;
    } else {
      current = { start: page.start, end: page.end, pages: [page] };
      bands.push(current);
    }
  }

  return bands;
};

/*
 * Contents links, as PDF annotations.
 *
 * The page is a **bitmap** — html2canvas draws bands, `cropPageFromBand` cuts pages, and
 * nothing in that path carries a link. So each `[TOC]` entry becomes a jsPDF link annotation
 * laid over the image at the entry's own position, pointing at the page its heading landed on.
 *
 * The coordinate mapping is exact rather than approximate:
 *
 *   pxPerMm = CONTENT_WIDTH_PX / PAGE_WIDTH_MM
 *   page n covers content y in [start, start + pageHeightPx)
 *   the image is drawn at (MARGIN_MM, MARGIN_MM), sized PAGE_WIDTH_MM x PAGE_HEIGHT_MM
 *
 * `RENDER_SCALE` never enters — it changes bitmap resolution, not geometry — and short pages
 * are padded at the bottom by `cropPageFromBand`, so a position within a page is preserved.
 *
 * **Measured before the band loop runs.** That loop mutates `content.style.marginTop` to shift
 * each band into view, so any rect read during it would be offset by the band's own scroll.
 */
let collectTocLinks = (content, pages, pageHeightPx, pxPerMm) => {
  const anchors = Array.from(content.querySelectorAll('.mb-toc a[href^="#"]'));
  if (anchors.length === 0) {
    return [];
  }

  const contentTop = content.getBoundingClientRect().top;
  const contentLeft = content.getBoundingClientRect().left;

  const pageOf = (y) => {
    const index = pages.findIndex((page) => y >= page.start && y < page.start + pageHeightPx);
    // A target past the last boundary belongs to the last page rather than to none.
    return index === -1 ? pages.length - 1 : index;
  };

  const links = [];

  anchors.forEach((anchor) => {
    const id = decodeURIComponent(anchor.getAttribute('href').slice(1));
    const target = content.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!target) {
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const top = rect.top - contentTop;
    const sourcePage = pageOf(top);
    const targetPage = pageOf(target.getBoundingClientRect().top - contentTop);

    links.push({
      sourcePage,
      targetPage,
      x: MARGIN_MM + (rect.left - contentLeft) / pxPerMm,
      y: MARGIN_MM + (top - pages[sourcePage].start) / pxPerMm,
      width: rect.width / pxPerMm,
      height: rect.height / pxPerMm
    });
  });

  return links;
};

/** Cuts one page out of a band canvas, padded to a full page so scaling stays uniform. */
let cropPageFromBand = (bandCanvas, page, bandStart, pageHeightPx) => {
  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = bandCanvas.width;
  pageCanvas.height = Math.round(pageHeightPx * RENDER_SCALE);

  const context = pageCanvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);

  const sourceY = Math.round((page.start - bandStart) * RENDER_SCALE);
  const sourceHeight = Math.min(
    Math.round((page.end - page.start) * RENDER_SCALE),
    bandCanvas.height - sourceY
  );

  if (sourceHeight > 0) {
    context.drawImage(
      bandCanvas,
      0,
      sourceY,
      bandCanvas.width,
      sourceHeight,
      0,
      0,
      pageCanvas.width,
      sourceHeight
    );
  }

  return pageCanvas;
};

/*
 * html2canvas renders a clone of the document, so forcing light colours here keeps the
 * PDF light-themed without the user ever seeing the page change.
 */
let decorateClone = (clonedDoc) => {
  /*
   * The preview stylesheet is tokenised, so flipping this one attribute on the clone
   * re-resolves every colour to the light ramp. This used to require fetching a separate
   * light stylesheet as text and injecting it; with a single token-driven sheet there is
   * nothing to fetch.
   */
  clonedDoc.documentElement.setAttribute('data-theme', 'light');

  /*
   * Colours only. Page offsets are measured against the live sandbox, so anything here
   * that changes layout would silently shift the content away from the boundaries the
   * crops were computed for. A `.mermaid svg` max-width override used to live here; it is
   * gone both because it broke that rule and because the diagrams are bitmaps by now.
   */
  const style = clonedDoc.createElement('style');
  style.id = 'export-light-css';
  style.textContent = `#pdf-export-sandbox, #pdf-export-content {
  background: #fff !important;
}`;
  clonedDoc.head.appendChild(style);
};

/**
 * "My Notes!" -> "my-notes.pdf", or any other extension.
 *
 * Shared by every export so one document produces one consistent basename across formats.
 */
export const filenameFromTitle = (title, extension = 'pdf') => {
  const slug = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  return `${slug || 'markbeam-document'}.${extension}`;
};

export const exportPreviewToPdf = async ({ title = 'Untitled', onProgress } = {}) => {
  const outputElement = document.querySelector('#output');
  if (!outputElement) {
    return;
  }

  const restoreDarkMermaid = getTheme() === 'dark';
  let sandbox = null;

  try {
    // Mermaid bakes theme colours into the SVG, so re-render light before cloning.
    await renderMermaidDiagrams('default');

    /*
     * html2canvas-pro, not html2canvas. The original's colour parser predates modern CSS
     * colour syntax and throws "unsupported color function" on `color-mix()`, which the
     * preview stylesheet uses. Pinning the design system to legacy rgba() instead would
     * only leave a trap for the next person who reaches for a modern colour function.
     */
    const [html2canvasModule, jsPdfModule] = await Promise.all([
      import('html2canvas-pro'),
      import('jspdf')
    ]);
    const html2canvas = html2canvasModule.default;
    const { jsPDF } = jsPdfModule;

    const pxPerMm = CONTENT_WIDTH_PX / PAGE_WIDTH_MM;
    const pageHeightPx = Math.floor(PAGE_HEIGHT_MM * pxPerMm);

    const created = createSandbox(outputElement, pageHeightPx);
    sandbox = created.sandbox;
    const content = created.content;

    // Must precede the measurement below: it swaps elements the offsets depend on.
    await rasteriseMermaidDiagrams(content);

    const totalHeight = content.scrollHeight;
    const offsets = computePageOffsets(content, pageHeightPx);
    const pages = offsets.map((start, index) => ({
      start,
      // A slice taller than the page would be drawn past the page canvas and lost.
      end: Math.min(index + 1 < offsets.length ? offsets[index + 1] : totalHeight, start + pageHeightPx)
    }));
    const bands = groupPagesIntoBands(pages);
    // Before the band loop: it shifts `content` per band, which would skew every rect.
    const tocLinks = collectTocLinks(content, pages, pageHeightPx, pxPerMm);

    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    let pageIndex = 0;

    for (const band of bands) {
      sandbox.style.height = `${band.end - band.start}px`;
      content.style.marginTop = `${-band.start}px`;

      const bandCanvas = await html2canvas(sandbox, {
        scale: RENDER_SCALE,
        useCORS: true,
        backgroundColor: '#ffffff',
        onclone: (clonedDoc) => decorateClone(clonedDoc)
      });

      for (const page of band.pages) {
        const pageCanvas = cropPageFromBand(bandCanvas, page, band.start, pageHeightPx);

        if (pageIndex > 0) {
          pdf.addPage();
        }

        pdf.addImage(
          pageCanvas.toDataURL('image/jpeg', 0.95),
          'JPEG',
          MARGIN_MM,
          MARGIN_MM,
          PAGE_WIDTH_MM,
          PAGE_HEIGHT_MM
        );

        pageIndex += 1;
        if (typeof onProgress === 'function') {
          onProgress(pageIndex, pages.length);
        }
      }
    }

    /*
     * Applied last, because `setPage` needs the page to exist. jsPDF places the annotation on
     * the current page, so the source page is selected first and the target given as a page
     * number — an internal jump, not a URL.
     */
    tocLinks.forEach((link) => {
      if (link.sourcePage >= pages.length || link.targetPage >= pages.length) {
        return;
      }
      pdf.setPage(link.sourcePage + 1);
      pdf.link(link.x, link.y, link.width, link.height, { pageNumber: link.targetPage + 1 });
    });

    pdf.save(filenameFromTitle(title));
    return { pages: pages.length, links: tocLinks.length };
  } finally {
    if (sandbox && sandbox.parentNode) {
      sandbox.parentNode.removeChild(sandbox);
    }
    if (restoreDarkMermaid) {
      renderMermaidForTheme('dark');
    }
  }
};
