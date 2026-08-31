/*
 * Automatic sync, and what happens on a conflict (T49).
 *
 * T37 shipped manual sync deliberately, and the reason was never squeamishness: every request
 * happened because someone had just asked for one, which is what made the claim on `/about`
 * checkable in the network panel rather than merely asserted. A timer weakens that, so this
 * module is built to send as little as it can get away with:
 *
 * - **Off unless switched on.** `loadAutoSync()` defaults to false.
 * - **Only a bound document.** A document that has never been saved to a repository has no
 *   remote path to write to, and inventing one would put files in people's repositories that
 *   they never asked for.
 * - **Only after a real change, and only once the editing stops.** A blind interval resends
 *   unchanged documents, which is exactly what makes a network panel unreadable.
 *
 * **The conflict rule is borrowed, not invented.** Pulled remote files already become *new
 * documents, never a replacement*, because a remote fetch that silently overwrites local work
 * is a data-loss path. A conflict is that same situation arriving on a timer, so it gets the
 * same answer: never merge, never overwrite, keep both and let the user choose. That is why
 * there is no merge algorithm here and should not be one — a merge that is wrong once costs
 * someone a document, and the whole point of this file is that nothing does.
 *
 * No imports: `main.js` injects everything, the way the rest of the app's modules talk. That
 * keeps the provider clients, storage and the DOM out of here, so the rules above can be
 * checked by reading one small file.
 */

/*
 * Long enough that it means "stopped typing" rather than "paused mid-sentence". The suite
 * waits IDLE_MS + 2s before asserting silence, so this must stay comfortably under that.
 */
const IDLE_MS = 3000;

export const createAutoSync = ({
  isEnabled,
  getBinding,
  setBinding,
  getActiveId,
  getText,
  readRemote,
  writeRemote,
  onConflict,
  onSynced,
  onError
}) => {
  let timer = null;
  let dirty = new Set();
  let running = false;

  let clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /*
   * Re-checked when the timer fires rather than captured when it started — `openDocument()`
   * calls `setValue()`, which fires the very change event that schedules this, so a timer
   * started under one document could otherwise write its text to another document's remote
   * path. `scheduleSnapshot` guards the same hazard for the same reason; there it costs a
   * wrong history entry, here it would cost a wrong file in someone's repository.
   */
  let sync = async (docId) => {
    if (running || !isEnabled()) {
      return;
    }

    const binding = getBinding(docId);
    if (!binding || getActiveId() !== docId) {
      return;
    }

    const text = getText(docId);
    if (typeof text !== 'string') {
      return;
    }

    running = true;
    try {
      const current = await readRemote(binding);

      /*
       * A remote we have never read, or one whose identifier has moved since we last wrote,
       * is a remote we are not entitled to overwrite. `current.ok === false` with a 404 means
       * the file is simply gone — that is not a conflict, it is a create.
       */
      const missing = !current.ok && current.status === 404;
      const moved = current.ok && binding.syncedId && current.id !== binding.syncedId;

      if (!current.ok && !missing) {
        onError?.(current);
        return;
      }

      if (moved) {
        dirty.delete(docId);
        onConflict?.({ binding, remoteText: current.text });
        return;
      }

      const written = await writeRemote(binding, text);
      if (!written.ok) {
        onError?.(written);
        return;
      }

      /*
       * Re-read rather than trusting the write's response body. GitHub returns the new sha,
       * GitLab returns only the path and branch, so one re-read is what lets both providers
       * share this path instead of growing a branch each. It is a GET, not a write, so it
       * cannot clobber anything if it races.
       */
      const after = await readRemote(binding);
      setBinding(docId, { ...binding, syncedId: after.ok ? after.id : null });
      dirty.delete(docId);
      onSynced?.({ binding });
    } catch (error) {
      onError?.({ ok: false, reason: 'Automatic sync could not complete' });
    } finally {
      running = false;
    }
  };

  return {
    /** Called on every content change. Cheap and silent unless everything lines up. */
    noteChange(docId) {
      if (!isEnabled() || !docId || !getBinding(docId)) {
        return;
      }
      dirty.add(docId);
      clear();
      timer = setTimeout(() => {
        timer = null;
        if (dirty.has(docId)) {
          sync(docId);
        }
      }, IDLE_MS);
    },

    /** Turning it off mid-countdown must not leave a write in flight behind it. */
    stop() {
      clear();
      dirty.clear();
    }
  };
};
