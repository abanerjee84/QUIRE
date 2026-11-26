/** Raster editor. The canvas holds committed edits; sliders preview until applied. */
export class ImageEditor {
  constructor(root, onChange) {
    this.root = root;
    this.onChange = onChange;
    this.scale = 1;
    this.history = [];
    this.future = [];
    this.mode = 'crop';
    this.selection = null;
    this.el = document.createElement('div');
    this.el.className = 'image-workspace';
    this.el.innerHTML = `<div class="image-stage"><div class="image-frame"><canvas class="image-canvas"></canvas><div class="image-overlay" aria-label="Image editing surface"><div class="crop-box" hidden><span class="crop-dimensions"></span><i data-handle="nw"></i><i data-handle="ne"></i><i data-handle="sw"></i><i data-handle="se"></i></div></div></div></div>
      <aside class="image-panel"><div class="image-panel-heading"><div><h2>Edit image</h2><p class="image-size"></p></div></div>
      <nav class="image-modes" aria-label="Image editing tools"><button data-image-mode="crop" class="active">Crop</button><button data-image-mode="adjust">Adjust</button><button data-image-mode="resize">Resize</button><button data-image-mode="draw">Draw</button><button data-image-mode="text">Text</button></nav>
      <section data-image-panel="crop"><h3>Crop image</h3><p class="image-help">Drag on the image to select an area. Move or drag a corner to refine it.</p>
        <label>Aspect ratio<select id="crop-ratio"><option value="free">Freeform</option><option value="1">Square · 1:1</option><option value="1.3333333333">Landscape · 4:3</option><option value="1.7777777778">Wide · 16:9</option><option value="0.75">Portrait · 3:4</option></select></label>
        <div class="image-actions"><button class="btn primary" id="image-crop" disabled>Crop selection</button><button class="btn ghost" id="crop-clear">Clear</button></div>
        <details class="image-precise"><summary>Exact crop bounds</summary><div class="image-fields"><label>Left <input id="crop-x" type="number" min="0" value="0"></label><label>Top <input id="crop-y" type="number" min="0" value="0"></label><label>Width <input id="crop-w" type="number" min="1"></label><label>Height <input id="crop-h" type="number" min="1"></label></div><button class="btn block" id="crop-use-bounds">Select bounds</button></details>
      </section>
      <section data-image-panel="adjust" hidden><h3>Adjust image</h3><p class="image-help">Preview changes as you move the sliders.</p>
        <label>Brightness <input id="image-brightness" type="range" min="0" max="200" value="100"></label><label>Contrast <input id="image-contrast" type="range" min="0" max="200" value="100"></label><label>Saturation <input id="image-saturation" type="range" min="0" max="200" value="100"></label><label>Blur <input id="image-blur" type="range" min="0" max="20" value="0"></label>
        <div class="image-actions"><button class="btn primary" id="image-apply">Apply</button><button class="btn ghost" id="image-adjust-reset">Reset sliders</button></div>
        <h3 class="image-subheading">Quick effects</h3><div class="image-effect-grid"><button class="btn" data-effect="grayscale(100%)">Black &amp; white</button><button class="btn" data-effect="sepia(100%)">Sepia</button><button class="btn" data-effect="invert(100%)">Invert</button></div>
      </section>
      <section data-image-panel="resize" hidden><h3>Resize image</h3><p class="image-help">Choose a size in pixels or scale by a percentage.</p><div class="image-fields"><label>Width <input id="image-width" type="number" min="1" max="20000"></label><label>Height <input id="image-height" type="number" min="1" max="20000"></label></div><label class="image-check"><input id="image-lock" type="checkbox" checked> Keep proportions</label><div class="image-presets"><button class="btn" data-resize="0.5">50%</button><button class="btn" data-resize="0.75">75%</button><button class="btn" data-resize="2">200%</button></div><button class="btn primary block" id="image-resize">Resize</button></section>
      <section data-image-panel="draw" hidden><h3>Draw on image</h3><p class="image-help">Drag on the image to draw. Each stroke can be undone.</p><label>Color <input id="draw-color" type="color" value="#e03131"></label><label>Brush size <input id="draw-width" type="range" min="1" max="80" value="5"><output id="draw-width-label">5 px</output></label></section>
      <section data-image-panel="text" hidden><h3>Add text</h3><p class="image-help">Enter text, then click where it should start on the image.</p><label>Text <input id="image-text" type="text" maxlength="200" placeholder="Type your text"></label><div class="image-fields"><label>Color <input id="text-color" type="color" value="#e03131"></label><label>Size (px) <input id="text-size" type="number" min="8" max="500" value="32"></label></div><label class="image-check"><input id="text-bold" type="checkbox" checked> Bold</label></section>
      <p class="image-note">Edits stay in this tab until you export.</p></aside>`;
    this.canvas = this.el.querySelector('.image-canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.frame = this.el.querySelector('.image-frame');
    this.overlay = this.el.querySelector('.image-overlay');
    this.box = this.el.querySelector('.crop-box');
    this.get = (id) => this.el.querySelector('#' + id);
    this.bind();
  }

  bind() {
    const get = this.get;
    this.el.querySelectorAll('[data-image-mode]').forEach((button) => button.addEventListener('click', () => this.setMode(button.dataset.imageMode)));
    get('image-resize').onclick = () => this.resize(+get('image-width').value, +get('image-height').value);
    get('image-width').addEventListener('input', () => { if (get('image-lock').checked && +get('image-width').value > 0) get('image-height').value = Math.max(1, Math.round(+get('image-width').value * this.canvas.height / this.canvas.width)); });
    get('image-height').addEventListener('input', () => { if (get('image-lock').checked && +get('image-height').value > 0) get('image-width').value = Math.max(1, Math.round(+get('image-height').value * this.canvas.width / this.canvas.height)); });
    this.el.querySelectorAll('[data-resize]').forEach((button) => button.addEventListener('click', () => { const n = +button.dataset.resize; get('image-width').value = Math.max(1, Math.round(this.canvas.width * n)); get('image-height').value = Math.max(1, Math.round(this.canvas.height * n)); }));
    get('image-crop').onclick = () => { if (this.selection) { const { x, y, w, h } = this.selection; this.crop(x, y, w, h); } };
    get('crop-clear').onclick = () => this.setSelection(null);
    get('crop-use-bounds').onclick = () => { const x = +get('crop-x').value, y = +get('crop-y').value, w = +get('crop-w').value, h = +get('crop-h').value; if (this.validCrop(x, y, w, h)) this.setSelection({ x, y, w, h }); else alert('Crop bounds must fit inside the image.'); };
    get('crop-ratio').onchange = () => this.setSelection(null);
    for (const id of ['image-brightness', 'image-contrast', 'image-saturation', 'image-blur']) get(id).addEventListener('input', () => { this.preview(); this.onChange(); });
    get('image-apply').onclick = () => this.applyAdjustments();
    get('image-adjust-reset').onclick = () => this.resetAdjustments();
    this.el.querySelectorAll('[data-effect]').forEach((button) => button.addEventListener('click', () => this.effect(button.dataset.effect)));
    get('draw-width').oninput = () => { get('draw-width-label').textContent = get('draw-width').value + ' px'; };
    this.overlay.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.overlay.addEventListener('pointercancel', (e) => this.pointerCancel(e));
  }

  setMode(mode) {
    this.mode = mode;
    this.el.dataset.mode = mode;
    this.el.querySelectorAll('[data-image-mode]').forEach((button) => { const active = button.dataset.imageMode === mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
    this.el.querySelectorAll('[data-image-panel]').forEach((panel) => { panel.hidden = panel.dataset.imagePanel !== mode; });
    this.renderSelection();
  }
  async load(data, snapshot) {
    this.root.appendChild(this.el);
    const url = snapshot?.current || await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(new Blob([data])); });
    await this.paint(url);
    this.original = snapshot?.original || url;
    this.history = snapshot?.history || [];
    this.future = snapshot?.future || [];
    this.scale = snapshot?.scale || 1;
    this.selection = snapshot?.selection || null;
    const adjustments = snapshot?.adjustments || [100, 100, 100, 0];
    ['image-brightness', 'image-contrast', 'image-saturation', 'image-blur'].forEach((id, i) => { this.get(id).value = adjustments[i]; });
    this.setMode(snapshot?.mode || 'crop');
    this.preview(); this.refresh();
    if (!snapshot) this.fitPage();
  }
  clear() { this.drag = null; this.el.remove(); }
  async paint(url) { const img = new Image(); img.src = url; await img.decode(); this.canvas.width = img.naturalWidth; this.canvas.height = img.naturalHeight; this.ctx.drawImage(img, 0, 0); this.refresh(); }
  snapshot() { return { current: this.canvas.toDataURL('image/png'), original: this.original, history: this.history.slice(), future: this.future.slice(), scale: this.scale, selection: this.selection, mode: this.mode, adjustments: this.adjustmentValues() }; }
  adjustmentValues() { return ['image-brightness', 'image-contrast', 'image-saturation', 'image-blur'].map((id) => +this.get(id).value); }
  filter() { const [b, c, s, blur] = this.adjustmentValues(); return `brightness(${b}%) contrast(${c}%) saturate(${s}%) blur(${blur}px)`; }
  hasAdjustments() { const [b, c, s, blur] = this.adjustmentValues(); return b !== 100 || c !== 100 || s !== 100 || blur !== 0; }
  preview() { const [b, c, s, blur] = this.adjustmentValues(); this.canvas.style.filter = this.hasAdjustments() ? `brightness(${b}%) contrast(${c}%) saturate(${s}%) blur(${blur * this.scale}px)` : ''; }
  resetAdjustments() { ['image-brightness', 'image-contrast', 'image-saturation', 'image-blur'].forEach((id, i) => { this.get(id).value = i === 3 ? 0 : 100; }); this.preview(); }
  saveHistory() { this.history.push(this.canvas.toDataURL('image/png')); if (this.history.length > 20) this.history.shift(); this.future = []; }
  sourceCanvas(withPreview = true) { const source = document.createElement('canvas'); source.width = this.canvas.width; source.height = this.canvas.height; const ctx = source.getContext('2d'); if (withPreview && this.hasAdjustments()) ctx.filter = this.filter(); ctx.drawImage(this.canvas, 0, 0); return source; }
  transform(w, h, draw) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 20000 || h > 20000 || w * h > 100000000) { alert('Choose valid dimensions up to 20,000 pixels per side and 100 megapixels.'); return; }
    const source = this.sourceCanvas(); this.saveHistory(); this.resetAdjustments();
    this.canvas.width = w; this.canvas.height = h; draw(this.ctx, source);
    this.setSelection(null); this.refresh(); this.onChange();
  }
  applyAdjustments() { if (this.hasAdjustments()) this.transform(this.canvas.width, this.canvas.height, (ctx, source) => ctx.drawImage(source, 0, 0)); }
  effect(filter) { this.transform(this.canvas.width, this.canvas.height, (ctx, source) => { ctx.filter = filter; ctx.drawImage(source, 0, 0); }); }
  rotate(dir) { const w = this.canvas.width, h = this.canvas.height; this.transform(h, w, (ctx, source) => { ctx.translate(h / 2, w / 2); ctx.rotate(dir * Math.PI / 2); ctx.drawImage(source, -w / 2, -h / 2); }); }
  flip(horizontal) { const w = this.canvas.width, h = this.canvas.height; this.transform(w, h, (ctx, source) => { ctx.translate(horizontal ? w : 0, horizontal ? 0 : h); ctx.scale(horizontal ? -1 : 1, horizontal ? 1 : -1); ctx.drawImage(source, 0, 0); }); }
  resize(w, h) { this.transform(w, h, (ctx, source) => ctx.drawImage(source, 0, 0, w, h)); }
  validCrop(x, y, w, h) { return [x, y, w, h].every(Number.isInteger) && x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= this.canvas.width && y + h <= this.canvas.height; }
  crop(x, y, w, h) { if (!this.validCrop(x, y, w, h)) { alert('Crop bounds must fit inside the image.'); return; } this.transform(w, h, (ctx, source) => ctx.drawImage(source, x, y, w, h, 0, 0, w, h)); }
  async undo() { if (this.hasAdjustments()) { this.resetAdjustments(); return; } if (!this.history.length) return; this.future.push(this.canvas.toDataURL('image/png')); await this.paint(this.history.pop()); this.setSelection(null); this.onChange(); }
  async redo() { if (!this.future.length) return; this.history.push(this.canvas.toDataURL('image/png')); await this.paint(this.future.pop()); this.setSelection(null); this.onChange(); }
  async reset() { if (!this.original) return; this.saveHistory(); this.resetAdjustments(); await this.paint(this.original); this.setSelection(null); this.onChange(); }

  point(e) { const r = this.overlay.getBoundingClientRect(); return { x: Math.max(0, Math.min(this.canvas.width, (e.clientX - r.left) * this.canvas.width / r.width)), y: Math.max(0, Math.min(this.canvas.height, (e.clientY - r.top) * this.canvas.height / r.height)) }; }
  setSelection(selection) { this.selection = selection; this.renderSelection(); }
  renderSelection() {
    const s = this.selection; this.box.hidden = !s || this.mode !== 'crop'; this.get('image-crop').disabled = !s;
    if (!s) return;
    Object.assign(this.box.style, { left: 100 * s.x / this.canvas.width + '%', top: 100 * s.y / this.canvas.height + '%', width: 100 * s.w / this.canvas.width + '%', height: 100 * s.h / this.canvas.height + '%' });
    this.el.querySelector('.crop-dimensions').textContent = `${s.w} × ${s.h}`;
    for (const [id, value] of [['crop-x', s.x], ['crop-y', s.y], ['crop-w', s.w], ['crop-h', s.h]]) this.get(id).value = value;
  }
  rectangle(a, b) {
    const ratio = +this.get('crop-ratio').value;
    let dx = b.x - a.x, dy = b.y - a.y;
    if (ratio) { const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1; let w = Math.max(Math.abs(dx), Math.abs(dy) * ratio); const maxW = sx > 0 ? this.canvas.width - a.x : a.x; const maxH = sy > 0 ? this.canvas.height - a.y : a.y; w = Math.min(w, maxW, maxH * ratio); dx = sx * w; dy = sy * w / ratio; }
    const x = Math.round(Math.min(a.x, a.x + dx)), y = Math.round(Math.min(a.y, a.y + dy));
    return { x, y, w: Math.min(this.canvas.width - x, Math.round(Math.abs(dx))), h: Math.min(this.canvas.height - y, Math.round(Math.abs(dy))) };
  }
  pointerDown(e) {
    if (e.button !== 0) return;
    const point = this.point(e);
    if (this.mode === 'text') {
      const text = this.get('image-text').value.trim(), size = +this.get('text-size').value;
      if (!text || !Number.isFinite(size) || size < 8 || size > 500) { this.get('image-text').focus(); return; }
      this.transform(this.canvas.width, this.canvas.height, (ctx, source) => { ctx.drawImage(source, 0, 0); ctx.fillStyle = this.get('text-color').value; ctx.font = `${this.get('text-bold').checked ? 'bold ' : ''}${size}px sans-serif`; ctx.textBaseline = 'top'; ctx.fillText(text, point.x, point.y); });
      return;
    }
    if (this.mode === 'draw') {
      if (this.hasAdjustments()) this.applyAdjustments();
      this.saveHistory(); this.ctx.strokeStyle = this.get('draw-color').value; this.ctx.lineWidth = +this.get('draw-width').value; this.ctx.lineCap = 'round'; this.ctx.lineJoin = 'round'; this.ctx.beginPath(); this.ctx.moveTo(point.x, point.y); this.ctx.lineTo(point.x + 0.01, point.y); this.ctx.stroke(); this.drag = { type: 'draw' };
    } else if (this.mode === 'crop') {
      const handle = e.target.dataset.handle;
      if (handle && this.selection) { const s = this.selection; const anchor = { x: handle.includes('w') ? s.x + s.w : s.x, y: handle.includes('n') ? s.y + s.h : s.y }; this.drag = { type: 'resize', anchor }; }
      else if (e.target.closest('.crop-box') && this.selection) this.drag = { type: 'move', start: point, original: { ...this.selection } };
      else { this.drag = { type: 'select', anchor: point }; this.setSelection(null); }
    } else return;
    e.preventDefault(); this.overlay.setPointerCapture(e.pointerId);
  }
  pointerMove(e) {
    if (!this.drag) return;
    const p = this.point(e), d = this.drag;
    if (d.type === 'draw') { this.ctx.lineTo(p.x, p.y); this.ctx.stroke(); return; }
    if (d.type === 'move') { const s = d.original; this.setSelection({ ...s, x: Math.round(Math.max(0, Math.min(this.canvas.width - s.w, s.x + p.x - d.start.x))), y: Math.round(Math.max(0, Math.min(this.canvas.height - s.h, s.y + p.y - d.start.y))) }); return; }
    const rect = this.rectangle(d.anchor, p); this.setSelection(rect.w && rect.h ? rect : null);
  }
  pointerUp(e) { if (!this.drag) return; const wasDraw = this.drag.type === 'draw'; this.drag = null; if (this.overlay.hasPointerCapture(e.pointerId)) this.overlay.releasePointerCapture(e.pointerId); if (wasDraw) { this.ctx.closePath(); this.onChange(); } }
  pointerCancel(e) { this.pointerUp(e); }
  refresh() {
    if (!this.canvas.width) return;
    this.el.querySelector('.image-size').textContent = `${this.canvas.width} × ${this.canvas.height} pixels`;
    this.get('image-width').value = this.canvas.width; this.get('image-height').value = this.canvas.height;
    this.canvas.style.width = Math.round(this.canvas.width * this.scale) + 'px'; this.canvas.style.height = Math.round(this.canvas.height * this.scale) + 'px';
    this.renderSelection();
  }
  setScale(n) { this.scale = Math.max(.05, Math.min(8, n)); this.refresh(); this.preview(); }
  zoomBy(n) { this.setScale(this.scale * n); }
  zoomReset() { this.setScale(1); }
  fitWidth() { this.setScale((this.el.querySelector('.image-stage').clientWidth - 48) / this.canvas.width); }
  fitPage() { const stage = this.el.querySelector('.image-stage'); this.setScale(Math.min((stage.clientWidth - 48) / this.canvas.width, (stage.clientHeight - 48) / this.canvas.height, 1)); }
  refit() {}
  async encode(type) { const source = this.hasAdjustments() ? this.sourceCanvas() : this.canvas; const blob = await new Promise((resolve) => source.toBlob(resolve, type, .92)); if (!blob) throw new Error('Could not encode image'); return new Uint8Array(await blob.arrayBuffer()); }
}
