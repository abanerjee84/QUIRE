/**
 * Markdown source editor.
 *
 * Quire renders Markdown; this is the one place where the file behind it is
 * written. It is a plain textarea over the reader surface: native undo,
 * keyboard-first, formatting buttons that wrap the current selection, and an
 * idle save so nothing is lost when the editor is closed.
 */
export class SourceEditor {
  /**
   * @param {HTMLElement} root the viewer element that holds pages and article
   * @param {{ onSave: Function, onStatus: Function, onClose: Function }} hooks
   */
  constructor(root, hooks = {}) {
    this.root = root;
    this.hooks = hooks;
    this.path = null;
    this.name = '';
    this.base = '';
    this.open = false;
    this.dirty = false;
    this.timer = null;
    this.build();
  }

  build() {
    const wrap = document.createElement('section');
    wrap.className = 'md-editor';
    wrap.dataset.surface = 'editor';
    wrap.hidden = true;

    wrap.innerHTML = `
      <div class="ed-bar">
        <span class="ed-name" id="ed-name"></span>
        <span class="ed-state" id="ed-state"></span>
        <span class="spacer"></span>
        <div class="ed-tools" id="ed-tools"></div>
        <span class="ed-div" role="separator" aria-hidden="true"></span>
        <button class="btn" id="ed-revert">Revert</button>
        <button class="btn primary" id="ed-save">Save</button>
        <button class="btn ghost" id="ed-close">Done</button>
      </div>
      <textarea id="ed-text" spellcheck="true" wrap="soft" aria-label="Markdown source"></textarea>
      <div class="ed-foot">
        <span id="ed-pos"></span>
        <span id="ed-stats"></span>
        <span class="spacer"></span>
        <span class="muted">Tab indents · Ctrl+S saves · Esc closes</span>
      </div>`;

    this.el = wrap;
    this.text = wrap.querySelector('#ed-text');
    this.nameEl = wrap.querySelector('#ed-name');
    this.stateEl = wrap.querySelector('#ed-state');
    this.posEl = wrap.querySelector('#ed-pos');
    this.statsEl = wrap.querySelector('#ed-stats');
    this.root.appendChild(wrap);

    const tools = [
      ['Bold', '**', '**', 'Ctrl+B'],
      ['Italic', '*', '*', 'Ctrl+I'],
      ['Heading', '\n## ', '', ''],
      ['Link', '[', '](url)', ''],
      ['Image', '![', '](image.png)', ''],
      ['Quote', '\n> ', '', ''],
      ['Code', '`', '`', ''],
      ['Code block', '\n```\n', '\n```\n', ''],
      ['List', '\n- ', '', ''],
      ['Table', '\n| Column | Column |\n| --- | --- |\n|  |  |\n', ''],
      ['Rule', '\n---\n', '']
    ];
    for (const [label, before, after, hint] of tools) {
      const btn = document.createElement('button');
      btn.className = 'btn ghost ed-btn';
      btn.textContent = label;
      if (hint) btn.title = label + ' (' + hint + ')';
      else btn.title = label;
      btn.addEventListener('click', () => this.wrap(before, after));
      wrap.querySelector('#ed-tools').appendChild(btn);
    }

    this.text.addEventListener('input', () => {
      this.dirty = this.text.value !== this.base;
      this.stateEl.textContent = this.dirty ? 'Unsaved' : 'Saved';
      this.stateEl.classList.toggle('dirty', this.dirty);
      this.text.classList.toggle('dirty', this.dirty);
      this.updateStats();
      this.scheduleSave();
    });
    this.text.addEventListener('keyup', () => this.updateStats());
    this.text.addEventListener('click', () => this.updateStats());
    this.text.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        this.insert('  ');
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hooks.onClose?.();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); this.wrap('**', '**'); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); this.wrap('*', '*'); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); }
    });

    wrap.querySelector('#ed-save').addEventListener('click', () => this.save());
    wrap.querySelector('#ed-revert').addEventListener('click', () => this.revert());
    wrap.querySelector('#ed-close').addEventListener('click', () => this.hooks.onClose?.());
  }

  show({ text, path, name }) {
    this.path = path;
    this.name = name;
    this.base = text;
    this.text.value = text;
    this.el.hidden = false;
    this.open = true;
    this.dirty = false;
    this.stateEl.textContent = 'Saved';
    this.stateEl.classList.remove('dirty');
    this.nameEl.textContent = name;
    this.text.classList.remove('dirty');
    this.text.setSelectionRange(0, 0);
    this.text.scrollTop = 0;
    this.text.scrollLeft = 0;
    this.updateStats();
    this.text.focus();
  }

  hide() {
    this.el.hidden = true;
    this.open = false;
    clearTimeout(this.timer);
  }

  get value() { return this.text.value; }

  /** Replace the buffer without marking it dirty (used after a reload). */
  reset(text) {
    this.base = text;
    this.text.value = text;
    this.dirty = false;
    this.stateEl.textContent = 'Saved';
    this.stateEl.classList.remove('dirty');
    this.text.classList.remove('dirty');
    this.updateStats();
  }

  async save({ silent = false } = {}) {
    clearTimeout(this.timer);
    if (!this.dirty) {
      if (!silent) this.hooks.onStatus?.('Nothing to save');
      return null;
    }
    const result = await this.hooks.onSave?.(this.text.value);
    if (result === null || result === undefined) return null;      // cancelled or failed
    this.base = this.text.value;
    this.dirty = false;
    this.stateEl.textContent = 'Saved';
    this.stateEl.classList.remove('dirty');
    this.text.classList.remove('dirty');
    return result;
  }

  revert() {
    this.text.value = this.base;
    this.dirty = false;
    this.stateEl.textContent = 'Saved';
    this.stateEl.classList.remove('dirty');
    this.text.classList.remove('dirty');
    this.updateStats();
    this.hooks.onStatus?.('Reverted to the last saved text');
  }

  scheduleSave() {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    this.timer = setTimeout(() => this.save({ silent: true }), 1200);
  }

  /** Flush an idle-pending save (called before the document is closed). */
  flush() {
    if (this.open && this.dirty) return this.save({ silent: true });
    return Promise.resolve(null);
  }

  insert(text) {
    const el = this.text;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const at = start + text.length;
    el.setSelectionRange(at, at);
    el.dispatchEvent(new Event('input'));
    el.focus();
  }

  /** Wrap the selection, or insert a placeholder when nothing is selected. */
  wrap(before, after) {
    const el = this.text;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const sel = el.value.slice(start, end);
    const body = sel || (before.trim() ? 'text' : '');
    el.value = el.value.slice(0, start) + before + body + after + el.value.slice(end);
    const from = start + before.length;
    el.setSelectionRange(from, from + body.length);
    el.dispatchEvent(new Event('input'));
    el.focus();
  }

  updateStats() {
    const value = this.text.value;
    const lines = value.split('\n');
    const upto = value.slice(0, this.text.selectionStart);
    const row = upto.split('\n').length;
    const col = upto.length - upto.lastIndexOf('\n');
    this.posEl.textContent = 'Line ' + row + ', col ' + col;
    this.statsEl.textContent = lines.length + ' lines · ' + value.length + ' characters';
  }
}
