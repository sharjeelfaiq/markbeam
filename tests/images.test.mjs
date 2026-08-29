import { seedDocument, sleep, withPage } from './lib.mjs';

/*
 * Local image insertion (T36).
 *
 * Every image is constructed inside Chrome. That makes this a test of the browser APIs the
 * feature actually uses — File, DataTransfer, canvas and WebP — without checking in opaque
 * binary fixtures. The noisy large image matters: a flat 2400px canvas compresses below the
 * limit before the app sees it and would not prove that the resize/quality loop did any work.
 */

const DOCS_KEY = 'markbeam:docs';

const boot = async (page) => {
  await page.waitForFunction(() => !!document.querySelector('#editor .monaco-editor'), {
    timeout: 30000
  });
  await sleep(1500);

  await page.evaluate(() => {
    const canvasBlob = (canvas, type, quality) =>
      new Promise((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error(`Could not encode ${type}`))),
          type,
          quality
        )
      );

    const makeFile = async (spec) => {
      if (spec.format === 'svg') {
        return new File(
          ['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'],
          spec.name,
          { type: 'image/svg+xml' }
        );
      }

      if (spec.format === 'gif') {
        const bytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), (c) =>
          c.charCodeAt(0)
        );
        return new File([bytes], spec.name, { type: 'image/gif' });
      }

      if (spec.format === 'markdown') {
        return new File([spec.text || '# Dropped document'], spec.name, {
          type: 'text/markdown'
        });
      }

      if (spec.format === 'binary') {
        return new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], spec.name, {
          type: 'application/octet-stream'
        });
      }

      const canvas = document.createElement('canvas');
      canvas.width = spec.width || 32;
      canvas.height = spec.height || 24;
      const context = canvas.getContext('2d');

      if (spec.noise) {
        const pixels = context.createImageData(canvas.width, canvas.height);
        let state = 0x5f3759df;
        for (let i = 0; i < pixels.data.length; i += 4) {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
          pixels.data[i] = state & 255;
          pixels.data[i + 1] = (state >>> 8) & 255;
          pixels.data[i + 2] = (state >>> 16) & 255;
          pixels.data[i + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
      } else {
        context.fillStyle = spec.color || '#0d9488';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#ffffff';
        context.fillRect(3, 3, Math.max(1, canvas.width / 3), Math.max(1, canvas.height / 3));
      }

      const type =
        spec.format === 'jpeg'
          ? 'image/jpeg'
          : spec.format === 'webp'
            ? 'image/webp'
            : 'image/png';
      const blob = await canvasBlob(canvas, type, 0.98);
      return new File([blob], spec.name, { type });
    };

    window.__dispatchT36Files = async (kind, specs) => {
      const files = [];
      for (const spec of specs) {
        files.push(await makeFile(spec));
      }

      window.__t36InputSizes = files.map((file) => file.size);
      const transfer = new DataTransfer();
      files.forEach((file) => transfer.items.add(file));

      const editors = window.monaco?.editor?.getEditors?.() || [];
      editors[0]?.focus();
      const target = document.querySelector('#editor textarea') || document.querySelector('#editor');
      target.focus();

      let event;
      if (kind === 'paste') {
        event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: transfer });
      } else {
        event = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer
        });
      }
      target.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented, sizes: window.__t36InputSizes };
    };
  });
};

const modelValue = (page) =>
  page.evaluate(() => {
    try {
      const active = JSON.parse(localStorage.getItem('markbeam:active_doc'))?.v;
      return active ? JSON.parse(localStorage.getItem(`markbeam:doc:${active}`))?.v ?? null : null;
    } catch (error) {
      return null;
    }
  });

const setModelValue = async (page, value) => {
  await page.click('#editor');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(value);
  await sleep(400);
};

const setLargeModelValue = async (page, length) => {
  await page.evaluate((size) => {
    const active = JSON.parse(localStorage.getItem('markbeam:active_doc'))?.v;
    const text = 'x'.repeat(size);
    localStorage.setItem(`markbeam:doc:${active}`, JSON.stringify({ v: text }));
    localStorage.setItem('markbeam:last_state', JSON.stringify({ v: text }));
  }, length);
  await page.reload({ waitUntil: 'networkidle2' });
  await boot(page);
};

const docCount = (page) =>
  page.evaluate((key) => {
    try {
      return JSON.parse(localStorage.getItem(key))?.v?.length ?? 0;
    } catch (error) {
      return 0;
    }
  }, DOCS_KEY);

const clearToasts = (page) =>
  page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((toast) => toast.remove()));

const toastText = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#toasts .toast')]
      .map((toast) => `${toast.dataset.tone || 'info'}: ${toast.textContent.trim()}`)
      .join(' | ')
  );

const dispatch = async (page, kind, specs) => {
  if (kind === 'paste') {
    // Monaco's `hasTextFocus()` follows its own focus service, not just
    // `document.activeElement`; a real pointer focus is required before a paste event.
    await page.click('#editor');
  }
  return page.evaluate(({ eventKind, fileSpecs }) => window.__dispatchT36Files(eventKind, fileSpecs), {
    eventKind: kind,
    fileSpecs: specs
  });
};

const imageDataUrls = (markdown) =>
  [...String(markdown || '').matchAll(/!\[[^\]]*\]\((data:image\/webp;base64,[A-Za-z0-9+/=]+)\)/g)].map(
    (match) => match[1]
  );

const inspectDataUrl = (page, url) =>
  page.evaluate(async (dataUrl) => {
    if (!dataUrl) return null;
    const blob = await fetch(dataUrl).then((response) => response.blob());
    const bitmap = await createImageBitmap(blob);
    const result = { bytes: blob.size, width: bitmap.width, height: bitmap.height, type: blob.type };
    bitmap.close();
    return result;
  }, url);

const runCommand = async (page, title) => {
  await page.click('#menu-button');
  await sleep(350);
  const found = await page.evaluate((wanted) => {
    const item = [...document.querySelectorAll('#palette-list .sheet__item')].find((button) =>
      button.textContent.includes(wanted)
    );
    if (!item) return false;
    item.click();
    return true;
  }, title);
  if (!found) await page.keyboard.press('Escape');
  await sleep(700);
  return found;
};

const rejected = async (page, kind, specs) => {
  await clearToasts(page);
  const before = await modelValue(page);
  const beforeDocs = await docCount(page);
  await dispatch(page, kind, specs);
  await sleep(1500);
  return {
    before,
    after: await modelValue(page),
    beforeDocs,
    afterDocs: await docCount(page),
    toast: await toastText(page)
  };
};

export const suite = {
  name: 'local images',
  async run() {
    return withPage(async (page, errors) => {
      const checks = [];
      const networkImages = [];

      await seedDocument(page, '# Image fixture\n\nImages follow:\n', 'Image fixture');
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);
      page.on('request', (request) => {
        if (request.resourceType() === 'image' && /^https?:/i.test(request.url())) {
          networkImages.push(request.url());
        }
      });

      const initialDocs = await docCount(page);

      // ---------- paste and drop insert into the active document ----------

      const pasteEvent = await dispatch(page, 'paste', [
        { name: 'image.png', format: 'png', color: '#e11d48' }
      ]);
      await sleep(1800);
      const afterPaste = await modelValue(page);
      const afterPasteDocs = await docCount(page);

      checks.push({
        name: 'pasting an image inserts WebP Markdown into the active document',
        pass:
          pasteEvent.defaultPrevented &&
          /!\[Pasted image\]\(data:image\/webp;base64,/.test(afterPaste || '') &&
          afterPasteDocs === initialDocs,
        detail: `prevented=${pasteEvent.defaultPrevented}, documents ${initialDocs} -> ${afterPasteDocs}, source ${JSON.stringify((afterPaste || '').slice(-90))}`
      });

      const dropEvent = await dispatch(page, 'drop', [
        { name: 'Dropped [photo].png', format: 'png', color: '#2563eb' }
      ]);
      await sleep(1800);
      const afterDrop = await modelValue(page);
      const afterDropDocs = await docCount(page);

      checks.push({
        name: 'dropping an image inserts it without creating another document',
        pass:
          dropEvent.defaultPrevented &&
          /!\[Dropped photo\]\(data:image\/webp;base64,/.test(afterDrop || '') &&
          afterDropDocs === initialDocs,
        detail: `prevented=${dropEvent.defaultPrevented}, documents ${initialDocs} -> ${afterDropDocs}, images=${imageDataUrls(afterDrop).length}, source ${JSON.stringify((afterDrop || '').slice(-90))}`
      });

      await sleep(500);
      const rendered = await page.evaluate(() =>
        [...document.querySelectorAll('#output img')].map((image) => ({
          src: image.getAttribute('src'),
          complete: image.complete,
          width: image.naturalWidth
        }))
      );
      checks.push({
        name: 'the preview renders embedded images without an image request',
        pass:
          rendered.length >= 2 &&
          rendered.every(
            (image) => image.src?.startsWith('data:image/webp;base64,') && image.complete && image.width > 0
          ) &&
          networkImages.length === 0,
        detail: `${rendered.length} rendered, ${networkImages.length} network image requests`
      });

      // ---------- persistence ----------

      const beforeReloadUrls = imageDataUrls(afterDrop);
      await page.reload({ waitUntil: 'networkidle2' });
      await boot(page);
      const afterReload = await modelValue(page);
      const afterReloadUrls = imageDataUrls(afterReload);
      checks.push({
        name: 'embedded images survive reload in the active document',
        pass:
          beforeReloadUrls.length === 2 &&
          afterReloadUrls.length === 2 &&
          beforeReloadUrls.every((url, index) => url === afterReloadUrls[index]),
        detail: `${beforeReloadUrls.length} -> ${afterReloadUrls.length} data URLs`
      });

      // ---------- a genuinely large, noisy input ----------

      await setModelValue(page, '# Large image\n\n');
      const beforeLarge = await modelValue(page);
      const largeEvent = await dispatch(page, 'drop', [
        { name: 'Large capture.png', format: 'png', width: 2400, height: 1800, noise: true }
      ]);
      await page
        .waitForFunction(
          () => {
            const active = JSON.parse(localStorage.getItem('markbeam:active_doc'))?.v;
            const text = active
              ? JSON.parse(localStorage.getItem(`markbeam:doc:${active}`))?.v || ''
              : '';
            const toast = [...document.querySelectorAll('#toasts .toast')]
              .map((element) => element.textContent)
              .join(' ');
            return text.includes('![Large capture]') || /could not|too large|storage/i.test(toast);
          },
          { timeout: 20000 }
        )
        .catch(() => {});
      const afterLarge = await modelValue(page);
      const largeUrl = imageDataUrls(afterLarge)[0];
      const largeResult = await inspectDataUrl(page, largeUrl);
      const largeInputBytes = await page.evaluate(() => window.__t36InputSizes?.[0] || 0);
      checks.push({
        name: 'large input is resized and compressed locally below the image limit',
        pass:
          largeEvent.defaultPrevented &&
          (afterLarge || '').length > (beforeLarge || '').length &&
          largeInputBytes > 300 * 1024 &&
          !!largeResult &&
          largeResult.type === 'image/webp' &&
          largeResult.bytes <= 300 * 1024 &&
          Math.max(largeResult.width, largeResult.height) <= 1600,
        detail: largeResult
          ? `${largeInputBytes}B ${2400}x${1800} -> ${largeResult.bytes}B ${largeResult.width}x${largeResult.height}`
          : `${largeInputBytes}B input, no embedded result; source ${JSON.stringify((afterLarge || '').slice(0, 100))}`
      });

      // ---------- order and undo are batch-atomic ----------

      await setModelValue(page, 'Order starts here:\n');
      const beforeBatch = await modelValue(page);
      await dispatch(page, 'drop', [
        { name: 'First image.png', format: 'png', color: '#f59e0b' },
        { name: 'Second image.jpg', format: 'jpeg', color: '#16a34a' }
      ]);
      await sleep(2200);
      const afterBatch = await modelValue(page);
      const firstAt = (afterBatch || '').indexOf('![First image]');
      const secondAt = (afterBatch || '').indexOf('![Second image]');

      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await sleep(800);
      const afterUndo = await modelValue(page);

      checks.push({
        name: 'multiple images preserve order and undo as one edit',
        pass:
          firstAt >= 0 &&
          secondAt > firstAt &&
          imageDataUrls(afterBatch).length === 2 &&
          afterUndo === beforeBatch,
        detail: `positions ${firstAt}, ${secondAt}; one undo restored=${afterUndo === beforeBatch}`
      });

      // ---------- unsupported and mixed inputs are atomic refusals ----------

      const svg = await rejected(page, 'drop', [
        { name: 'vector.svg', format: 'svg' }
      ]);
      checks.push({
        name: 'SVG is refused with an image-specific explanation',
        pass:
          svg.after === svg.before &&
          svg.afterDocs === svg.beforeDocs &&
          /svg/i.test(svg.toast) &&
          /not supported|cannot|only/i.test(svg.toast),
        detail: svg.toast || 'no toast'
      });

      const gif = await rejected(page, 'paste', [
        { name: 'animated.gif', format: 'gif' }
      ]);
      checks.push({
        name: 'GIF is refused instead of silently losing animation',
        pass:
          gif.after === gif.before &&
          gif.afterDocs === gif.beforeDocs &&
          /gif|animat/i.test(gif.toast) &&
          /not supported|cannot|only/i.test(gif.toast),
        detail: gif.toast || 'no toast'
      });

      const mixed = await rejected(page, 'drop', [
        { name: 'kept.png', format: 'png', color: '#7c3aed' },
        { name: 'notes.md', format: 'markdown', text: '# Must not open' }
      ]);
      checks.push({
        name: 'a mixed image and document drop is refused as a whole',
        pass:
          mixed.after === mixed.before &&
          mixed.afterDocs === mixed.beforeDocs &&
          /image/i.test(mixed.toast) &&
          /document|file|separat|mixed/i.test(mixed.toast),
        detail: `${mixed.beforeDocs} -> ${mixed.afterDocs} documents, ${mixed.toast || 'no toast'}`
      });

      const unsupported = await rejected(page, 'drop', [
        { name: 'photo.avif', format: 'binary' }
      ]);
      checks.push({
        name: 'an unsupported file still leaves the document unchanged',
        pass:
          unsupported.after === unsupported.before &&
          unsupported.afterDocs === unsupported.beforeDocs &&
          /error/i.test(unsupported.toast),
        detail: unsupported.toast || 'no toast'
      });

      // ---------- document and storage budgets ----------

      await setLargeModelValue(page, 1024 * 1024 - 16);
      const overBudget = await rejected(page, 'drop', [
        { name: 'too-much.png', format: 'png', color: '#dc2626' }
      ]);
      checks.push({
        name: 'an image that would take Markdown over 1 MiB is refused',
        pass:
          overBudget.after === overBudget.before &&
          overBudget.afterDocs === overBudget.beforeDocs &&
          /1\s*MiB/i.test(overBudget.toast),
        detail: `${overBudget.toast || 'no toast'}; ${overBudget.after?.length || 0} characters`
      });

      await setModelValue(page, '# Storage probe\n\n');
      await page.evaluate(() => {
        window.__t36OriginalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (String(key).includes('capacity_probe')) {
            throw new DOMException('Test quota reached', 'QuotaExceededError');
          }
          return window.__t36OriginalSetItem.call(this, key, value);
        };
      });
      const storageConstrained = await rejected(page, 'paste', [
        { name: 'stored.png', format: 'png', color: '#0891b2' }
      ]);
      await page.evaluate(() => {
        Storage.prototype.setItem = window.__t36OriginalSetItem;
        delete window.__t36OriginalSetItem;
      });
      checks.push({
        name: 'a failed temporary storage-capacity check refuses the image',
        pass:
          storageConstrained.after === storageConstrained.before &&
          storageConstrained.afterDocs === storageConstrained.beforeDocs &&
          /storage|space|capacity/i.test(storageConstrained.toast),
        detail: storageConstrained.toast || 'no toast'
      });

      // ---------- self-contained Markdown and HTML export ----------

      await page.evaluate(() => {
        window.__t36Downloads = [];
        const originalCreate = URL.createObjectURL;
        URL.createObjectURL = function (blob) {
          const url = originalCreate.call(URL, blob);
          const record = { url, type: blob.type, text: null, name: null };
          window.__t36Downloads.push(record);
          blob.text().then((text) => {
            record.text = text;
          });
          return url;
        };

        const originalClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          const record = window.__t36Downloads.find((download) => download.url === this.href);
          if (record) record.name = this.getAttribute('download');
          // Do not navigate away from the app during the suite.
        };
      });

      await setModelValue(page, '# Embedded export\n\n');
      await dispatch(page, 'drop', [
        { name: 'Exported image.webp', format: 'webp', color: '#0f766e' }
      ]);
      await sleep(1800);
      const exportSource = await modelValue(page);
      const exportUrl = imageDataUrls(exportSource)[0];

      await runCommand(page, 'Export as Markdown');
      await runCommand(page, 'Export as HTML');
      await sleep(700);
      const downloads = await page.evaluate(() => window.__t36Downloads || []);
      const markdownFile = downloads.find((file) => /\.md$/i.test(file.name || ''));
      const htmlFile = downloads.find((file) => /\.html$/i.test(file.name || ''));

      checks.push({
        name: 'Markdown and HTML exports retain the embedded image',
        pass:
          !!exportUrl &&
          markdownFile?.text?.includes(exportUrl) &&
          htmlFile?.text?.includes(exportUrl) &&
          /<img[\s>]/i.test(htmlFile?.text || ''),
        detail: `markdown=${!!markdownFile?.text?.includes(exportUrl)}, html=${!!htmlFile?.text?.includes(exportUrl)}`
      });

      checks.push({
        name: 'no console errors',
        pass: errors.length === 0,
        detail: errors[0]
      });

      return checks;
    });
  }
};
