/**
 * Whole-document text search.
 *
 * The query runs over whatever surface is open — pdf.js page text or the
 * rendered Markdown article. A hit is a page plus a character range in that
 * page's plain text; the surface turns it into a DOM range.
 */
export class Search {
  constructor(surface = null) {
    this.surface = surface;
    this.query = '';
    this.caseSensitive = false;
    this.hits = [];
    this.cursor = -1;
    this.busy = false;
    this.marked = null;
  }

  async run(query, { onProgress, onDone } = {}) {
    this.query = query;
    // Every run owns a number. reset() and a newer run bump it, so a scan that
    // is still walking pages knows it has been superseded and stops feeding
    // hits into a search the user has already changed.
    const run = (this._run = (this._run || 0) + 1);
    const stale = () => this._run !== run;

    if (!query.trim() || !this.surface?.doc) {
      this.reset();
      onDone?.([]);
      return;
    }

    this.busy = true;
    this.hits = [];
    this.cursor = -1;

    const total = this.surface.pageCount;
    const needle = this.caseSensitive ? query : query.toLowerCase();

    for (let page = 1; page <= total; page++) {
      if (stale()) return [];
      const str = await this.surface.searchText(page);
      if (str) {
        const hay = this.caseSensitive ? str : str.toLowerCase();
        let idx = hay.indexOf(needle);
        while (idx !== -1) {
          this.hits.push({
            page,
            start: idx,
            end: idx + needle.length,
            snippet: str.slice(Math.max(0, idx - 30), idx + needle.length + 30).trim()
          });
          idx = hay.indexOf(needle, idx + 1);
        }
      }
      if (!stale()) onProgress?.({ scanned: page, total, hits: this.hits.length });
      // hand the frame back so the UI keeps painting on long documents
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (stale()) return [];
    this.busy = false;
    this.cursor = this.hits.length ? 0 : -1;
    onDone?.(this.hits);
    return this.hits;
  }

  /** Move the cursor and return the hit under it. */
  step(direction) {
    if (!this.hits.length) return null;
    const base = this.cursor < 0 ? (direction > 0 ? -1 : 0) : this.cursor;
    this.cursor = (base + direction + this.hits.length) % this.hits.length;
    return this.hits[this.cursor];
  }

  go(n) {
    if (!this.hits.length) return null;
    this.cursor = Math.min(Math.max(n, 0), this.hits.length - 1);
    return this.hits[this.cursor];
  }

  async jump(hit) {
    if (!hit) return null;
    const surface = this.surface;
    if (surface.revealPage) surface.revealPage(hit.page);
    else surface.gotoPage?.(hit.page);
    await surface.ensureRendered?.(hit.page);

    const field = document.activeElement;
    const typing = !!field && /^(INPUT|TEXTAREA|SELECT)$/.test(field.tagName);
    const el = surface.markHit(hit, typing);
    if (!el) return hit;

    this.marked?.classList.remove('hit-current');
    this.marked = typing ? el : null;

    el.classList.add('hit-flash');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => el.classList.remove('hit-flash'), 1000);
    return hit;
  }

  reset() {
    this._run = (this._run || 0) + 1;
    this.busy = false;
    this.surface?.clearHitMarks?.();
    this.marked = null;
    this.hits = [];
    this.cursor = -1;
  }
}
