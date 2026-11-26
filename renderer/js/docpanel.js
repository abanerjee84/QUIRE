/**
 * Document panel: everything that changes the PDF itself.
 *
 * Page order, rotation, size, stamps, numbering, find-and-replace, metadata
 * and form fields. Every control turns into one op and goes straight to
 * src/doc-edit.js in the main process, which answers with new bytes and a page
 * mapping so the app can move the annotations along with their page.
 */

const SIZES = {
  keep: 'Keep page size',
  a4: 'A4 (210 × 297 mm)',
  letter: 'Letter (8.5 × 11 in)',
  legal: 'Legal',
  a5: 'A5',
  a3: 'A3',
  tabloid: 'Tabloid'
};

const POSITIONS = {
  'top-left': 'Top left',
  'top-center': 'Top centre',
  'top-right': 'Top right',
  'middle-left': 'Middle left',
  'middle-center': 'Centre',
  'middle-right': 'Middle right',
  'bottom-left': 'Bottom left',
  'bottom-center': 'Bottom centre',
  'bottom-right': 'Bottom right'
};

export class DocPanel {
  /**
   * @param {{ panelEl: HTMLElement, api: object, hooks: {
   *   getBytes: Function, apply: Function, status: Function, merge: Function,
   *   findText: Function, contentBoxes: Function, goTo: Function, isPdf: Function
   * } }} opts
   */
  constructor({ panelEl, api, hooks }) {
    this.el = panelEl;
    this.api = api;
    this.hooks = hooks;
    this.info = null;
    this.fields = null;
    this.hits = [];
    this.build();
  }

  build() {
    this.el.innerHTML = `
      <div class="doc-panel">
        <p class="empty-note" id="dp-none">Open a PDF to edit its pages.</p>

        <div id="dp-body" hidden>
          <div class="dp-target">
            <label for="dp-pages">Pages</label>
            <input id="dp-pages" value="all" spellcheck="false"
                   title="all, odd, even, 2, 1-3, 2,5">
            <button class="btn ghost" id="dp-revert" title="Discard every document change">Revert</button>
          </div>

          <section class="dp-sec">
            <h4>Page list <span class="muted" id="dp-count"></span></h4>
            <div class="dp-page-list" id="dp-page-list"></div>
          </section>

          <section class="dp-sec">
            <h4>Size &amp; crop</h4>
            <div class="dp-row">
              <select id="dp-size">${Object.entries(SIZES).map(([k, v]) =>
                `<option value="${k}">${v}</option>`).join('')}</select>
              <label class="dp-check"><input type="checkbox" id="dp-landscape">Landscape</label>
              <label class="dp-check"><input type="checkbox" id="dp-fit" checked>Keep proportions</label>
              <button class="btn" id="dp-resize">Resize</button>
            </div>
            <div class="dp-row">
              <button class="btn ghost" id="dp-trim" title="Cut the page down to its content">Trim margins</button>
              <input type="range" id="dp-inset" min="0" max="25" step="1" value="8">
              <span class="muted" id="dp-inset-label">8%</span>
              <button class="btn ghost" id="dp-inset-btn">Trim evenly</button>
            </div>
          </section>

          <section class="dp-sec">
            <h4>Stamp &amp; numbering</h4>
            <div class="dp-row">
              <input id="dp-stamp-text" placeholder="DRAFT, CONFIDENTIAL, …" spellcheck="false">
              <select id="dp-stamp-pos">${Object.entries(POSITIONS).map(([k, v]) =>
                `<option value="${k}">${v}</option>`).join('')}</select>
              <input class="dp-num" id="dp-stamp-size" type="number" value="24" min="6" max="72" step="1">
              <input class="dp-color" id="dp-stamp-color" type="color" value="#c1121f">
              <label class="dp-check"><input type="checkbox" id="dp-stamp-bold" checked>Bold</label>
              <button class="btn" id="dp-stamp">Stamp</button>
            </div>
            <div class="dp-row">
              <input id="dp-num-format" value="{n} / {total}" spellcheck="false"
                     title="{n} page number, {total} page count">
              <select id="dp-num-pos">${Object.entries(POSITIONS).map(([k, v]) =>
                `<option value="${k}">${v}</option>`).join('')}</select>
              <button class="btn" id="dp-num">Number pages</button>
            </div>
            <div class="dp-row">
              <button class="btn ghost" id="dp-reverse">Reverse order</button>
              <button class="btn ghost" id="dp-blank">Insert blank page after current</button>
              <button class="btn ghost" id="dp-merge">Merge another PDF…</button>
            </div>
          </section>

          <section class="dp-sec">
            <h4>Find &amp; replace</h4>
            <div class="dp-row">
              <input id="dp-find" placeholder="Find in text" spellcheck="false">
              <button class="btn" id="dp-find-btn">Find</button>
              <span class="muted" id="dp-find-count"></span>
            </div>
            <div class="dp-hits" id="dp-hits"></div>
            <div class="dp-row">
              <input id="dp-replace" placeholder="Replace with" spellcheck="false">
              <button class="btn" id="dp-replace-btn">Replace selected</button>
              <button class="btn ghost" id="dp-replace-all">Replace all</button>
            </div>
            <p class="dp-note">Replacement text is painted over the original glyphs in Helvetica —
              the surrounding font is not reproduced.</p>
          </section>

          <section class="dp-sec">
            <h4>Metadata</h4>
            <div class="dp-grid">
              <label>Title<input id="md-title"></label>
              <label>Author<input id="md-author"></label>
              <label>Subject<input id="md-subject"></label>
              <label>Keywords<input id="md-keywords" placeholder="comma, separated"></label>
              <label>Creator<input id="md-creator"></label>
              <label>Producer<input id="md-producer"></label>
            </div>
            <div class="dp-row">
              <button class="btn" id="md-save">Save metadata</button>
              <span class="muted" id="md-dates"></span>
            </div>
          </section>

          <section class="dp-sec" id="dp-form-sec" hidden>
            <h4>Form fields <span class="muted" id="dp-form-count"></span></h4>
            <div class="dp-form" id="dp-form"></div>
            <div class="dp-row">
              <button class="btn" id="dp-form-apply">Apply values</button>
              <button class="btn ghost" id="dp-form-flatten">Flatten form</button>
              <button class="btn ghost" id="dp-form-clear">Clear fields</button>
            </div>
          </section>
        </div>
      </div>`;

    const on = (id, event, fn) => this.el.querySelector(id).addEventListener(event, fn);
    const val = (id) => this.el.querySelector(id).value;

    on('#dp-pages', 'input', () => this.renderPages());
    on('#dp-revert', 'click', () => this.hooks.revert());
    on('#dp-resize', 'click', () => {
      const size = val('#dp-size');
      if (size === 'keep') return this.hooks.status('Pick a page size first');
      this.hooks.apply([{
        op: 'resize',
        pages: this.target(),
        size,
        landscape: this.el.querySelector('#dp-landscape').checked,
        fit: this.el.querySelector('#dp-fit').checked
      }]);
    });
    on('#dp-trim', 'click', () => this.trim());
    on('#dp-inset', 'input', () => {
      this.el.querySelector('#dp-inset-label').textContent = val('#dp-inset') + '%';
    });
    on('#dp-inset-btn', 'click', () => this.hooks.apply([
      { op: 'crop', pages: this.target(), inset: Number(val('#dp-inset')) }
    ]));
    on('#dp-stamp', 'click', () => {
      const text = val('#dp-stamp-text').trim();
      if (!text) return this.hooks.status('Stamp text is empty');
      this.hooks.apply([{
        op: 'stamp',
        pages: this.target(),
        text,
        position: val('#dp-stamp-pos'),
        size: Number(val('#dp-stamp-size')),
        color: val('#dp-stamp-color'),
        bold: this.el.querySelector('#dp-stamp-bold').checked
      }]);
    });
    on('#dp-num', 'click', () => this.hooks.apply([{
      op: 'pageNumbers',
      pages: this.target(),
      format: val('#dp-num-format'),
      position: val('#dp-num-pos'),
      size: 10,
      color: '#5f6673'
    }]));
    on('#dp-reverse', 'click', () => this.hooks.apply([{ op: 'reverse' }]));
    on('#dp-blank', 'click', () => this.hooks.apply([
      // The blank joins the page it follows, so the document keeps one size.
      { op: 'insertBlank', after: this.hooks.currentPage(), size: this.hooks.pageSize?.() || null }
    ]));
    on('#dp-merge', 'click', () => this.hooks.merge());
    on('#dp-find-btn', 'click', () => this.find());
    on('#dp-find', 'keydown', (e) => { if (e.key === 'Enter') this.find(); });
    on('#dp-replace-btn', 'click', () => this.replace(false));
    on('#dp-replace-all', 'click', () => this.replace(true));
    on('#md-save', 'click', () => {
      this.hooks.apply([{
        op: 'metadata',
        title: val('#md-title'),
        author: val('#md-author'),
        subject: val('#md-subject'),
        keywords: val('#md-keywords'),
        creator: val('#md-creator'),
        producer: val('#md-producer')
      }]);
    });
    on('#dp-form-apply', 'click', () => this.applyForm(false));
    on('#dp-form-flatten', 'click', () => this.applyForm(true));
    on('#dp-form-clear', 'click', () => this.hooks.apply([{ op: 'clearForm' }]));
  }

  target() {
    const text = this.el.querySelector('#dp-pages').value.trim();
    return text || 'all';
  }

  /** Reflect the current document: page list, metadata, fields. */
  async refresh() {
    const pdf = this.hooks.isPdf?.();
    this.el.querySelector('#dp-none').hidden = !!pdf;
    this.el.querySelector('#dp-body').hidden = !pdf;
    if (!pdf) {
      // Nothing to edit: drop the stale page rows so the tab cannot claim a
      // document that has just been closed.
      this.el.querySelector('#dp-page-list').replaceChildren();
      this.el.querySelector('#dp-count').textContent = '';
      return;
    }

    const info = await this.api.docInfo(this.hooks.getBytes());
    if (!info || info.error) {
      this.hooks.status('Could not read document: ' + (info?.error || 'unknown'));
      return;
    }
    this.info = info;
    this.el.querySelector('#dp-count').textContent = info.pageCount + ' page' + (info.pageCount === 1 ? '' : 's');
    this.renderPages();

    const meta = info.metadata;
    for (const [id, key] of [['#md-title', 'title'], ['#md-author', 'author'], ['#md-subject', 'subject'],
      ['#md-keywords', 'keywords'], ['#md-creator', 'creator'], ['#md-producer', 'producer']]) {
      this.el.querySelector(id).value = meta[key] || '';
    }
    const dates = [meta.creationDate && 'created ' + meta.creationDate.slice(0, 10),
      meta.modifiedDate && 'modified ' + meta.modifiedDate.slice(0, 10)].filter(Boolean).join(' · ');
    this.el.querySelector('#md-dates').textContent = dates;

    this.fields = null;
    const formSec = this.el.querySelector('#dp-form-sec');
    if (info.hasForm) {
      const read = await this.api.docFields(this.hooks.getBytes());
      this.fields = read?.fields || [];
      formSec.hidden = false;
      this.el.querySelector('#dp-form-count').textContent = this.fields.length + ' field' + (this.fields.length === 1 ? '' : 's');
      this.renderForm();
    } else {
      formSec.hidden = true;
    }
  }

  renderPages() {
    const list = this.el.querySelector('#dp-page-list');
    list.replaceChildren();
    if (!this.info) return;
    const wanted = this.target();

    for (const page of this.info.pages) {
      const row = document.createElement('div');
      row.className = 'dp-page';
      row.dataset.page = String(page.page);

      const num = document.createElement('button');
      num.className = 'dp-num-btn';
      num.textContent = String(page.page);
      num.title = 'Go to page ' + page.page;
      num.addEventListener('click', () => this.hooks.goTo(page.page));

      const size = document.createElement('span');
      size.className = 'dp-page-size';
      const dims = Math.round(page.width) + ' × ' + Math.round(page.height);
      size.textContent = page.rotation ? dims + ' · ' + page.rotation + '°' : dims;
      size.title = dims + ' pt' + (page.rotation ? ', rotated ' + page.rotation + '°' : '');

      const buttons = document.createElement('span');
      buttons.className = 'dp-page-btns';
      const add = (label, title, fn) => {
        const b = document.createElement('button');
        b.className = 'icon-btn dp-mini';
        b.title = title;
        b.textContent = label;
        b.addEventListener('click', fn);
        buttons.appendChild(b);
      };
      add('↑', 'Move page earlier', () => this.hooks.apply([{ op: 'move', pages: [page.page], to: 'left' }]));
      add('↓', 'Move page later', () => this.hooks.apply([{ op: 'move', pages: [page.page], to: 'right' }]));
      add('⟳', 'Rotate 90°', () => this.hooks.apply([{ op: 'rotate', pages: [page.page], delta: 90 }]));
      add('⧉', 'Duplicate page', () => this.hooks.apply([{ op: 'duplicate', pages: [page.page] }]));
      add('✕', 'Delete page', () => this.hooks.apply([{ op: 'delete', pages: [page.page] }]));

      row.append(num, size, buttons);
      if (matches(page.page, wanted)) row.classList.add('selected');
      list.appendChild(row);
    }
  }

  async trim() {
    const rows = await this.hooks.contentBoxes();
    if (!rows) return this.hooks.status('Content could not be measured');
    const boxes = {};
    for (const row of rows) if (row?.box) boxes[row.page] = row.box;
    if (!Object.keys(boxes).length) return this.hooks.status('No content found to trim to');
    this.hooks.apply([{ op: 'crop', pages: this.target(), boxes }]);
  }

  async find() {
    const query = this.el.querySelector('#dp-find').value.trim();
    const countEl = this.el.querySelector('#dp-find-count');
    const hitsEl = this.el.querySelector('#dp-hits');
    if (!query) return;
    countEl.textContent = 'searching…';
    this.hits = await this.hooks.findText(query);
    countEl.textContent = this.hits.length + ' match' + (this.hits.length === 1 ? '' : 'es');
    hitsEl.replaceChildren();

    for (const [index, hit] of this.hits.entries()) {
      const row = document.createElement('label');
      row.className = 'dp-hit';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.dataset.index = String(index);
      const page = document.createElement('em');
      page.textContent = 'p' + hit.page;
      const text = document.createElement('span');
      text.textContent = hit.snippet || '';
      row.append(box, page, text);
      row.addEventListener('click', (e) => {
        if (e.target === box) return;
        this.hooks.goTo(hit.page);
      });
      hitsEl.appendChild(row);
    }
    if (!this.hits.length) {
      const none = document.createElement('p');
      none.className = 'empty-note';
      none.textContent = 'Nothing matched.';
      hitsEl.appendChild(none);
    }
  }

  replace(all) {
    const replacement = this.el.querySelector('#dp-replace').value;
    if (!replacement.trim()) return this.hooks.status('Replacement text is empty');
    if (!this.hits.length) return this.hooks.status('Find something first');

    const chosen = all
      ? this.hits
      : [...this.el.querySelectorAll('.dp-hit input:checked')]
        .map((box) => this.hits[Number(box.dataset.index)])
        .filter(Boolean);
    if (!chosen.length) return this.hooks.status('No matches selected');

    // Group by page; doc-edit paints one cover rectangle per occurrence.
    const hits = chosen.map((h) => ({ page: h.page, rects: h.rects }));
    this.hooks.apply([{ op: 'replace', hits, replacement }], { after: () => {
      this.el.querySelector('#dp-hits').replaceChildren();
      this.el.querySelector('#dp-find-count').textContent = '';
      this.hits = [];
    } });
  }

  applyForm(flatten) {
    if (!this.fields) return;
    const values = {};
    for (const input of this.el.querySelectorAll('.dp-field-input')) {
      values[input.dataset.name] = input.type === 'checkbox' ? input.checked : input.value;
    }
    this.hooks.apply([{ op: 'formValues', values, flatten }]);
  }

  renderForm() {
    const wrap = this.el.querySelector('#dp-form');
    wrap.replaceChildren();
    for (const field of this.fields || []) {
      const row = document.createElement('div');
      row.className = 'dp-field';

      const label = document.createElement('span');
      label.className = 'dp-field-name';
      label.textContent = field.name + (field.page ? ' · p' + field.page : '');
      label.title = field.kind + (field.required ? ' (required)' : '') + (field.readOnly ? ' (read only)' : '');

      let input;
      if (field.kind === 'checkbox') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!field.value;
      } else if (field.kind === 'radio' || field.kind === 'dropdown' || field.kind === 'list') {
        input = document.createElement('select');
        input.dataset.name = field.name;
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '(empty)';
        input.appendChild(blank);
        for (const option of field.options) {
          const opt = document.createElement('option');
          opt.value = option;
          opt.textContent = option;
          if (option === field.value) opt.selected = true;
          input.appendChild(opt);
        }
      } else if (field.kind === 'signature') {
        input = document.createElement('span');
        input.className = 'muted';
        input.textContent = 'signature field';
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = field.value || '';
        if (field.multiline) input.classList.add('multiline');
      }
      if (input.dataset && input.dataset.name === undefined && 'value' in input) input.dataset.name = field.name;
      input.className = (input.className ? input.className + ' ' : '') + 'dp-field-input';
      if (field.readOnly) input.disabled = true;

      row.append(label, input);
      wrap.appendChild(row);
    }
  }
}

/** Is a page number inside the user's page expression? (rough, for row highlight) */
function matches(page, spec) {
  if (!spec || spec === 'all') return true;
  for (const part of String(spec).split(',')) {
    const bit = part.trim().toLowerCase();
    if (!bit) continue;
    if (bit === 'odd') { if (page % 2) return true; continue; }
    if (bit === 'even') { if (page % 2 === 0) return true; continue; }
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(bit);
    if (range) { if (page >= Number(range[1]) && page <= Number(range[2])) return true; continue; }
    if (Number(bit) === page) return true;
  }
  return false;
}
