/*
 * Hand a Blob to the browser as a download.
 *
 * PDF export never needed this — jsPDF has its own `save()` — so this is the first shared
 * download path. The object URL is revoked on the next frame rather than immediately:
 * Firefox and Safari have both been known to cancel a download whose URL is revoked in the
 * same tick as the click.
 */
export const downloadBlob = (filename, blob) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  requestAnimationFrame(() => URL.revokeObjectURL(url));
};

export const downloadText = (filename, text, type) =>
  downloadBlob(filename, new Blob([text], { type }));
