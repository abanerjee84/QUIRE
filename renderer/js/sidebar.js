const KIND_LABEL = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strikethrough',
  note: 'Note',
  ink: 'Ink',
  rect: 'Shape',
  ellipse: 'Ellipse',
  arrow: 'Arrow'
};

/** Left panel: page thumbnails and the annotation index. */
export class Sidebar {
  constructor({ viewer, thumbsEl, marksEl, onJump, onDelete, onClear }) {
    this.viewer = viewer;
    this.thumbsEl = thumbsEl;
    this.marksEl = marksEl;
    this.onJump = onJump;
    this.onDelete = onDelete;
    this.onClear = onClear;
    this.thumbs = [];
    this.counts = { total: 0 };
    this.kind = 'pdf';

    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.target._made) continue;
        entry.target._made = true;
        this.paintThumb(entry.target);
      }
    }, { root: this.thumbsEl, rootMargin: '200px 0px' });
  }

  /** Markdown has no pages to restructure, so the Document tab goes away. */
  setKind(kind) {
    this.kind = kind;
    const docTab = document.querySelector('#tab-doc');
    if (!docTab) return;
    docTab.hidden = kind === 'markdown';
    if (kind !== 'markdown' || !docTab.classList.contains('active')) return;
    docTab.classList.remove('active');
    document.querySelector('#pane-doc')?.classList.remove('active');
    const pagesTab = document.querySelector('#tab-thumbs');
    pagesTab?.classList.add('active');
    document.querySelector('#pane-thumbs')?.classList.add('active');
  }

  buildThumbs() {
    this.observer.disconnect();
    this.thumbs = [];
    this.thumbsEl.replaceChildren();

    for (const page of this.viewer.pages) {
      const item = document.createElement('button');
      item.className = 'thumb';
      item.dataset.page = String(page.num);
      item.title = 'Page ' + page.num;

      const frame = document.createElement('div');
      frame.className = 'thumb-frame';
      frame.style.aspectRatio = `${page.w} / ${page.h}`;
      const num = document.createElement('span');
      num.className = 'thumb-num';
      num.textContent = String(page.num);

      item.append(frame, num);
      item.addEventListener('click', () => this.onJump(page.num));
      this.thumbsEl.appendChild(item);
      this.thumbs.push(item);
      this.observer.observe(item);
    }
  }

  async paintThumb(item) {
    const num = Number(item.dataset.page);
    const canvas = await this.viewer.renderThumbnail(num, 132);
    if (!canvas) {
      item._made = false;
      this.observer.observe(item);
      return;
    }
    item.querySelector('.thumb-frame').appendChild(canvas);
  }

  /** Markdown has no pages: the heading outline plays the same role. */
  buildOutline(outline) {
    this.observer.disconnect();
    this.thumbs = [];
    this.thumbsEl.replaceChildren();

    if (!outline.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'This document has no headings to navigate.';
      this.thumbsEl.appendChild(empty);
      return;
    }

    for (const item of outline) {
      const row = document.createElement('button');
      row.className = 'outline-item';
      row.dataset.page = String(item.index);
      row.dataset.level = String(item.level);
      row.title = item.text || 'Untitled';

      const dot = document.createElement('span');
      dot.className = 'outline-dot';
      const label = document.createElement('span');
      label.className = 'outline-label';
      label.textContent = item.text || 'Untitled';

      row.append(dot, label);
      row.addEventListener('click', () => this.onJump(item.index));
      this.thumbsEl.appendChild(row);
      this.thumbs.push(row);
    }
  }

  setCurrent(num) {
    for (const item of this.thumbs) item.classList.toggle('active', Number(item.dataset.page) === num);
    const active = this.thumbs[num - 1];
    if (!active) return;
    const box = this.thumbsEl.getBoundingClientRect();
    const r = active.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) active.scrollIntoView({ block: 'center' });
  }

  renderMarks(annotations) {
    this.counts.total = annotations.length;
    this.marksEl.replaceChildren();

    if (!annotations.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-note';
      empty.textContent = 'No annotations yet. Select text to highlight, or press Ctrl+M to drop a note.';
      this.marksEl.appendChild(empty);
      return;
    }

    const header = document.createElement('div');
    header.className = 'marks-head';
    const label = document.createElement('span');
    label.textContent = annotations.length + ' annotation' + (annotations.length === 1 ? '' : 's');
    const clear = document.createElement('button');
    clear.className = 'link-btn';
    clear.textContent = 'Clear all';
    clear.addEventListener('click', () => this.onClear());
    header.append(label, clear);
    this.marksEl.appendChild(header);

    const byPage = new Map();
    for (const a of annotations) {
      if (!byPage.has(a.page)) byPage.set(a.page, []);
      byPage.get(a.page).push(a);
    }

    for (const [page, marks] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
      const group = document.createElement('section');
      group.className = 'mark-group';
      const title = document.createElement('h4');
      title.textContent = this.kind === 'markdown' ? 'In this document' : 'Page ' + page;
      group.appendChild(title);

      for (const a of marks) {
        const row = document.createElement('div');
        row.className = 'mark-row';
        row.tabIndex = 0;

        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.style.background = a.color;

        const body = document.createElement('div');
        body.className = 'mark-body';
        const kind = document.createElement('em');
        kind.textContent = KIND_LABEL[a.kind] || a.kind;
        const text = document.createElement('p');
        text.textContent = describe(a);
        body.append(kind, text);

        const del = document.createElement('button');
        del.className = 'icon-btn del';
        del.title = 'Delete';
        del.innerHTML = '&#10005;';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onDelete(a.id);
        });

        const jump = () => this.onJump(a);
        row.addEventListener('click', jump);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(); });

        row.append(chip, body, del);
        group.appendChild(row);
      }
      this.marksEl.appendChild(group);
    }
  }
}

function describe(a) {
  if (a.kind === 'note') return a.text ? a.text : 'Empty note';
  if (a.kind === 'ink') return 'Freehand drawing';
  if (a.kind === 'rect' || a.kind === 'ellipse') return 'Shape';
  if (a.kind === 'arrow') return 'Arrow';
  if (a.text) return a.text;
  const box = a.rects?.[0];
  return box ? `${Math.round(box.w)} × ${Math.round(box.h)} pt region` : 'Region';
}
