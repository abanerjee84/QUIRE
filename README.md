# Quire

Electron PDF reader with scrolling pages, selectable text, whole-document search, and eight markup tools. Marks are kept in a JSON sidecar next to the PDF; the PDF's own bytes change only when you edit the document or export.

The same window reads Markdown: rendered article with KaTeX, an outline, search, block-anchored marks, and a source editor that writes the file back.

PDFs, Markdown and images open in document tabs. Use Ctrl+Tab to switch and Ctrl+W to close the active tab. In the image editor, drag to select a crop, move or resize its corners, choose an aspect ratio, and press Crop selection. Exact pixel bounds are also available. Resize keeps proportions by default; adjustment sliders preview brightness, contrast, saturation and blur. The Draw and Text tools work directly on the image, and quick effects include black and white, sepia and invert. Rotate, flip, undo, redo and reset are available. Export to PNG, JPEG or WebP writes a separate file and includes any visible adjustment preview. GIF images are edited as a single frame; animation is not preserved. Export the image before closing its tab to keep changes.

Use **Copy image** to put the current edited image and visible adjustment preview on the clipboard. Preferences (Ctrl+,) control appearance, reopening the previous tabs, and remembering reading positions. Settings and session paths are stored in Quire's user-data folder. Restored tabs reopen the files on disk; unsaved PDF changes and unexported image edits are not restored. The Open dialog also has an All files filter, although Quire only reads supported formats.

## Running

```
npm install
npx electron .       # window opens; use File > Open or drag in a document or image
npm run dev          # same, with devtools open
npm run sample       # writes samples/: two PDFs, a Markdown document with LaTeX, a PNG, notes.txt
npm run check        # syntax check every source file (ESM and CommonJS)
npm run test         # check, doc-edit and smoke, in one command
npm run doc-edit     # every page operation in src/doc-edit.js, in plain Node
npm run smoke        # export and server checks in plain Node, no window
npm run e2e          # drives the real window over the Chrome debug port
npm run e2e:chrome   # cold start, theme, sidebar, help, print rules, recents
npm run e2e:interactions  # 45 human steps across every tool, search, zoom, export, themes
npm run e2e:markdown      # Markdown + KaTeX rendering, outline, search, anchors, rendered export
npm run e2e:edit          # page operations, marks that follow them, print options, Markdown source editing
npm run e2e:tabs          # multi-document tab switching and restoration
npm run e2e:image         # image editing and export
npm run e2e:session       # preferences and workspace restore across restarts
npm run shots        # screenshots + layout assertions for the panels and dialogs (test/out/ux-*.png)
npm run build        # unpacked build/Quire-win32-x64/Quire.exe
npm run dist         # unsigned unless signing credentials are configured; installer and ZIP
npm run dist:release # requires code signing; installer and ZIP
npm run dist:portable # explicitly build the portable target
npm run verify:exe   # drive the unpacked exe
npm run verify:portable   # test the actual portable executable, if available
npm run launch:time -- <exe>   # spawn to first page painted
```

`npm run e2e` needs a display and puppeteer. It looks for puppeteer in `$PUPPETEER_PATH`, then `node_modules`, then `npm root -g`. It generates the sample PDFs if they are missing.

## Building an exe

Run `npm run build` for an unpacked app, or `npm run dist` for the installer and ZIP using the locally installed Electron. The default build may be unsigned. For distribution, configure a trusted Windows code-signing certificate with electron-builder and run `npm run dist:release`; this fails if signing cannot be performed. Do not put certificate passwords or private keys in this repository. Signing identifies the publisher and verifies integrity; it does not guarantee an antivirus verdict.

The portable self-extractor has been quarantined by Avast on this machine. It is not built by default, and the build does not move or retry quarantined artifacts. If a file is detected, preserve the alert details and submit the detected sample to Avast for review. Do not disable protection or assume the detection is a false positive. `npm run dist:portable` builds the portable target only when explicitly requested.

Use `node test/verify-exe.js --exe <path>` to test a specific packaged executable. The portable verification fails if that executable is unavailable; it does not silently test a different binary.

## Markup

| Tool | Result |
| --- | --- |
| Highlight | Rectangles snapped to text boxes, colour from the swatch row |
| Underline, Strikethrough | One stroke per line, fragments on the same line merged |
| Note | Pin on the page, text in a popup editor |
| Ink | Freehand stroke, weight 1 to 8 pt (PDF only) |
| Rectangle | Outline box (PDF only) |
| Ellipse | Oval fitted to the drag box, same weight control (PDF only) |
| Arrow | Straight stroke with an open arrow head (PDF only) |
| Eraser | Deletes the object under the cursor |

Select text and press the highlight tool to mark it. On a page with no text layer, the same tool drags a box instead; `samples/scan-sample.pdf` is an image-only page for exactly that case.

Undo and redo walk the annotation list. `Ctrl+S` forces a save, otherwise the sidecar is written 900 ms after the last change, and closing the window flushes unsaved marks synchronously before the renderer goes away.

## Editing a PDF

The sidebar's `Document` tab works on the file rather than on the marks. It sends structured operations to `src/doc-edit.js`, which runs pdf-lib in the main process, and the renderer reloads the surface from the returned bytes.

| Operation | What it does |
| --- | --- |
| Order, move, reverse | The page field takes `1,3-4`, `even`, `odd`, `all` or a list |
| Delete, duplicate | Duplicates get no provenance, so they arrive without the original's marks |
| Insert blank | Joins the size of the page it follows, not a fixed A4 |
| Merge | Another PDF, whole or by page range, spliced in after the current page |
| Resize | Preset (A3 to tabloid), exact width and height, landscape, or `fit` which keeps the aspect ratio and centres the content |
| Trim margins | Measures each page's text, images, paths and annotations, then crops the media and crop boxes to that box |
| Stamp, page numbers | Helvetica at any of nine positions; `{n}` and `{total}` expand in the number format |
| Find & replace | Hits come from pdf.js's text layer; a replacement paints a cover rectangle over the old glyphs and writes the new word in Helvetica |
| Metadata | Title, author, subject, keywords |
| Form fields | Text, checkbox and list fields read from the AcroForm, filled, cleared, flattened; XFA removed |

Marks follow their page. `applyOps` returns a provenance map — new page index back to the page it came from — and `remapMarks` moves each mark to the first page carrying its original page. A mark whose page is deleted goes with it, and comes back with `Ctrl+Z` along with the page. The sidecar is rewritten after every operation.

`Ctrl+Shift+S` writes the staged bytes over the file (`Ctrl+Shift+S` on Markdown saves the source text). `Ctrl+Shift+O` puts back the file as it sits on disk; marks are kept. `Ctrl+N`, and the New PDF button on the welcome screen, start a blank one-pager you can stamp, number and merge into.

Page sizes come from the viewer, so `trim` measures what pdf.js actually drew: text item boxes, image paints, path construction and annotation rects, with a 12 pt margin. Rotated pages are skipped rather than cropped wrong, and the operation says how many.

## Markdown and LaTeX

A file is a document of one of two kinds, decided from its bytes before its name: `%PDF-` at the offset 0 means PDF, a NUL byte means binary and is refused with a toast, otherwise an extension in `.md .markdown .mdown .mdwn .mkd .mkdn .mdx .txt .text` means Markdown. `package.json` is refused, `notes.txt` is read as Markdown.

`marked` renders CommonMark plus GFM — tables, task lists, fenced code, strikethrough — and the HTML it produces goes through a sanitizer before it touches the page: `script`, `style`, `iframe`, `object`, `form` and friends are dropped, `on*` handlers and `javascript:`/`data:` targets are stripped, and only a fixed attribute list survives (`href src alt title class id style width height align colspan rowspan start type lang dir`, plus `data-*`). Math is lifted out of the source first, so `marked` never mangles it, and typeset back through KaTeX: `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` display. Both libraries are served from `node_modules` over the local server (`/vendor/marked`, `/vendor/katex`), so nothing is bundled by hand.

Headings become the outline. The sidebar's first tab reads `Outline` instead of `Pages`, `Ctrl+PageDown`/`Ctrl+PageUp` and `Ctrl+G` move between sections, and the status bar counts sections rather than pages. Zoom scales the article's type instead of a bitmap, so reflow happens at any size.

Marks on Markdown are anchors, not rectangles: a highlight stores `{ block, start, end }`, the character range inside one top-level block, and is repainted as a `<span>` over that range. Changing zoom, resizing the window or editing the document between sessions moves the ink, not the anchor. Notes pin to a block and open a floating editor beside it. Ink, rectangle, ellipse and arrow need PDF coordinates and are refused with a toast.

### Editing the source

The toolbar's `Edit` button puts the file's own text in a textarea over the article. The bar above it wraps the selection in bold, italic, code, a link, a heading, a list or a quote, and `Ctrl+S` writes it back to the same path. Left idle for 1.2 s the editor saves itself; `Done` closes it and repaints the article.

Marks survive the edit. After every save `reanchor()` checks each mark's stored character range against the text now in that block; if the range no longer spells the mark's text, it searches the new blocks for that text and re-anchors to the block that holds it. A mark whose text has been deleted keeps its note and loses its range, and the status line says how many were lost.

Export writes the rendered article to PDF through Electron's `printToPDF` (`Ctrl+Shift+X`); `annot` and `flatten` only mean something for a PDF source, and asking for one on Markdown says so. Relative images resolve against the document's folder through `/local?path=…`; `https:` and `mailto:` links go to the OS, and a relative link to another readable file opens it in Quire.

## Printing and other exports

`Ctrl+P` opens a print dialog instead of firing the OS print: orientation, paper (`Letter`, `Legal`, `A4`, `A5`, `B5`, `JIS-B4`, `JIS-B5`), margins (`none`, `minimal`, `normal` — 0, 0.2, 0.6 inches) and whether to print backgrounds. It exports through `printToPDF`, so the same dialog produces a PDF or hands the job to a printer. Toolbar, sidebar and editor chrome are hidden by the `@media print` rules.

The export menu also holds:

- **Standalone HTML** (`Ctrl+Shift+H`, Markdown): the rendered article with its stylesheet inlined and local images embedded as data URLs. No Quire markup, no editor chrome, readable on its own.
- **Marks as Markdown** (`Ctrl+Shift+M`): one section per mark, grouped by kind, with the quoted text, the page or section it sits on, its colour, and any note text.
- **Save document** (PDF, after an edit) and **Save As** (either kind).

## Sidecar file

`<document-name>.marks.json`, written beside the document — the extension stays in the name, so
`report.pdf.marks.json` and `report.md.marks.json` are different files. If that folder is not writable the
file goes to `<userData>/marks/<name>.json` instead, and the status pill names whichever file was used.

```json
{
  "format": "quire-marks/1",
  "savedAt": "2025-01-14T10:31:02.412Z",
  "document": { "path": "…/quire-sample.pdf", "name": "quire-sample.pdf", "size": 4364, "pageCount": 3 },
  "annotations": [
    { "id": "a7f3c1", "page": 1, "kind": "highlight", "color": "#f2c811",
      "rects": [{ "x": 56, "y": 140.54, "w": 113.69, "h": 12.32 }], "text": "Quire keeps annotations" }
  ]
}
```

Kinds: `highlight`, `underline`, `strikeout`, `rect` and `ellipse` carry `rects`; `ink` and `arrow` carry `points`; `note` carries `x`, `y` and `text`. A corrupt entry (unknown kind, non-numeric page) is dropped on load rather than crashing the paint.

Geometry is stored in PDF points measured from the top-left of the page, so zoom and window size never change a mark. The overlay SVG on each page uses a viewBox equal to the page size in points, which is why the markup lines up at every zoom level. `src/export-pdf.js` flips Y to the PDF's bottom-left origin at export time.

## Export

Two modes, both leaving the source file alone:

- **Annotations** (`Ctrl+Shift+E`) writes real PDF objects: `/Highlight` with `QuadPoints`, `/Text` with `Contents`, `/Ink` with `InkPoints`, `/Square`, `/Circle`, and `/Line` with an open head for arrows. Acrobat, Chrome and Preview show these as markup.
- **Flattened** (`Ctrl+Shift+B`) draws the markup into the page content stream. Viewers that ignore annotations still show it, and the result survives being emailed around with no sidecar.

Exporting twice into the same file appends a second set of annotation objects rather than replacing the first. Export to a new name.

## Layout

```
src/main.js            window, menu, IPC, recent list (12 entries), sidecar read/write, kind detection, print-to-PDF
src/server.js          localhost static server: renderer/, pdfjs-dist, /vendor/marked, /vendor/katex, /local?path=
src/export-pdf.js      pdf-lib export, both modes
src/doc-edit.js        page operations on the PDF itself: order, delete, merge, resize, crop, stamp, metadata, form fields
renderer/preload.js    the only bridge the page can reach (window.api)
renderer/js/viewer.js       pdf.js rendering, text layer, zoom, thumbnails, text search, content measurement
renderer/js/markdown.js     marked + KaTeX article, outline, block anchors, search surface, HTML export, re-anchoring
renderer/js/annotations.js  annotation state, tools, pointer handling, SVG painting
renderer/js/search.js       document-wide search
renderer/js/sidebar.js      page thumbnails, the mark index, and the Document tab
renderer/js/docpanel.js     the Document tab: page list, resize, trim, stamp, numbering, merge, find & replace, metadata, forms
renderer/js/edit.js         Markdown source editor: toolbar, dirty state, idle save, revert
renderer/js/app.js          toolbar, shortcuts, autosave, export, note editor, document operations
tools/make-icon.js    generates assets/quire.ico
tools/build.js        @electron/packager run
tools/dist.js         electron-builder run, with a writable portable artifact name
tools/inspect-build.js  lists what went into resources/app.asar
tools/launch-time.js  spawn to first page painted, for any exe
```

The renderer is served over `http://127.0.0.1:<port>` rather than `file://` because pdf.js runs its parser as an ES-module worker, and module workers do not load from a `file://` origin. The server binds loopback only, resolves paths inside two roots (`renderer/` and `node_modules/pdfjs-dist`), and refuses anything that escapes them; the page CSP allows only `'self'`. Node integration is off in the renderer, so `window.api` is the whole attack surface.

Pages render lazily: an IntersectionObserver with a 400 px margin starts a render when a page approaches the viewport and cancels it when it leaves. Text extraction is separate and on demand, used by the text layer, the search index, and highlight snapping.

## Keyboard

| Key | Action |
| --- | --- |
| `Ctrl+O` / `Ctrl+W` | Open / close document |
| `Ctrl+S` | Save marks to the sidecar |
| `Ctrl+Shift+E` / `Ctrl+Shift+B` | Export annotations / flattened (PDF sources) |
| `Ctrl+Shift+X` | Export the rendered Markdown article as PDF |
| `Ctrl+F`, `Enter`, `Shift+Enter` | Search, next hit, previous hit |
| `Ctrl+1` … `Ctrl+4` | Select, highlight, underline, eraser |
| `Ctrl+H` `Ctrl+U` `Ctrl+K` `Ctrl+M` `Ctrl+D` `Ctrl+R` | Highlight, underline, strikethrough, note, ink, rectangle |
| `Ctrl+E` / `Ctrl+Shift+A` | Ellipse / arrow |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo a mark, then a document change / redo a mark |
| `Ctrl+=` `Ctrl+-` `Ctrl+0` | Zoom in, out, 100% |
| `Ctrl+Shift+F` / `Ctrl+Shift+P` | Fit width / fit page; on Markdown these set the article width and type scale |
| `Ctrl+PageDown` / `Ctrl+PageUp` | Next / previous page, or section on Markdown |
| `Ctrl+G` | Go to page, or to section on Markdown |
| `Ctrl+B` | Sidebar |
| `Ctrl+Shift+L` | Theme |
| `Ctrl+N` | New blank PDF |
| `Ctrl+Shift+S` / `Ctrl+Shift+O` | Save the document itself / revert to the file on disk |
| `Ctrl+Shift+H` / `Ctrl+Shift+M` | Standalone HTML / marks as a Markdown list |
| `Ctrl+P` | Print, with paper and margin options, chrome hidden |
| `Ctrl+/` | Shortcut list |

`Ctrl` means `Cmd` on macOS.

## Tests

`test/check.js` (`npm run check`) syntax-checks every `.js` under `src/`, `renderer/js/`, `test/` and `tools/` — 29 files, renderer modules as ESM, main-process files as CommonJS.

`test/doc-edit.test.js` (`npm run doc-edit`) drives `src/doc-edit.js` without a window: blank documents at three paper sizes, page summaries, reorder/move/delete/duplicate/insert-blank with the provenance map, rotate, resize including fit and landscape, crop from measured boxes and by inset, replace, stamp and page numbering, metadata, form fields read/filled/cleared/flattened, merge by bytes and by path, composed operations, and unknown ops reported rather than thrown. It finishes by running the whole set over `samples/quire-sample.pdf`.

`test/smoke.js` runs in Node: it builds an 8-mark set — highlight, underline, strikeout, ink, rectangle, note, ellipse, arrow — exports both modes, then reloads the output with pdf-lib and asserts the page count, the subtype list `[/Circle, /Highlight, /Ink, /Line, /Line, /Line, /Square, /Text]`, 8 `QuadPoints` on the highlight, note contents, that the flattened file is larger than the original, and that the server serves `pdf.worker.mjs` while refusing `../../` traversal.

`test/e2e.js` launches Electron with `--remote-debugging-port`, attaches puppeteer, and checks the live window: 3 pages painted, text layer with spans and boxes, a real mouse drag producing a highlight in PDF points, a note typed into the editor, an ink stroke, 6 search matches for "annotations", the zoom label, the sidecar written as `quire-marks/1`, sidebar rows and thumbnails, both exports containing `/Highlight`, `/Ink` and `/Text` objects, the flattened file reopening with 0 sidecar marks, eraser deleting a mark and undo restoring it, and a dragged box becoming a highlight on the text-free page. Screenshots land in `test/out/`.

`test/e2e-chrome.js` starts the app with no file argument and checks the rest: the welcome screen is up with nothing loaded, `boot` reports platform and version, opening a file hides the welcome and renames the window to `<file> — Quire`, the recent list gains the file, `Ctrl+Shift+L` flips the theme, `Ctrl+B` widens the viewer by the sidebar, `Ctrl+/` opens the shortcut dialog, a `@media print` rule hides the toolbar, and `Ctrl+W` returns to the welcome screen. `test/cdp.js` holds the launch and attach plumbing both tests share.

`test/e2e-interactions.js` (`npm run e2e:interactions`) is the human pass: 45 steps in one window, in the order a person would do them. It types into the search box one character at a time and checks the box keeps focus while the debounce runs, navigates hits with `Enter`/`Shift+Enter`, zooms and fits, switches every tool and checks the weight control appears for exactly the six tools that have one, changes colour and ink weight, highlights by drag, drops a note, reopens it, cancels a second one with `Escape`, draws an ink stroke, a rectangle, an ellipse and an arrow — the arrow checked for both shaft and head — erases the mark actually under the cursor by id, undoes and redoes that same id, saves with `Ctrl+S`, watches autosave pick up a note, opens and closes the export menu, exports and reads the annotation objects back with pdf-lib, flips the theme, checks the window title, opens a file Quire cannot read, opens a path that does not exist, opens the image-only PDF, searches it with no matches, and closes the document. Pointer steps scroll the target page into the viewer first, because puppeteer clicks viewport pixels.

`test/e2e-markdown.js` (`npm run e2e:markdown`) drives the Markdown surface: headings and tables and code fences render, KaTeX paints a fraction, superscript and a root, the outline tab lists sections and jumps to them, `Ctrl+PageDown` moves a section, search finds text across sections, a drag highlights a phrase inside one block, a note anchors to a block, marks survive a reload of the same file, `Ctrl+Shift+X` exports the rendered article to a PDF, a PDF still opens as a PDF, `notes.txt` renders as Markdown, `package.json` is refused, both themes stay readable, and the PDF-only tools report a toast instead of drawing. Screenshots land in `test/out/`.

`test/e2e-edit.js` (`npm run e2e:edit`) drives the editing surface in a real window over a copy of the sample PDF: the Document tab lists the pages; a highlight is made, then page 1 is deleted and the mark moves with it, and deleting the marked page drops the mark and empties the sidecar; `Ctrl+Z` puts the page and the mark back; duplicating a page does not clone its marks; resize takes one page to Letter; trim cuts every page to its measured content; reverse flips the order; a stamp and page numbers land as text the search layer can read; find lists hits and Replace all rewrites them; metadata typed into the panel reaches the file on disk; revert gives back the file as it sits there; a merge appends a second PDF's pages; an inserted blank page joins the size of the page it follows; print options produce landscape sheets then portrait ones of a different size; a blank PDF is created and opened. Then the Markdown sample: the editor opens over the article, the toolbar wraps the selection, saving writes the file and re-renders, a highlight keeps its anchor through the edit, standalone HTML and the marks list export, Save As writes a copy elsewhere, and the sample is restored at the end with no console errors.

`npm run shots` (`test/shots.js`) is the eyeball pass: it screenshots the surfaces a unit test cannot judge — the Document tab scrolled through every section at the default sidebar width and at 320 px, the export menu, the print dialog, the welcome screen, the Markdown reader, the source editor, the shortcut list — and asserts what it saw: three page rows with one-line size labels, no sideways overflow in the pane, a two-column metadata grid only when there is room, Escape closing the export menu, four controls in the print dialog, a cleared mark badge and empty page list after closing the document, the editor opening at line 1 with eleven formatting buttons ahead of a divider, and 26 shortcut rows. The images are written to `test/out/ux-*.png`.

Packaged binaries can be tested with `node test/verify-exe.js --exe <path>`.

## Limits

- Markup written by other apps is not read in. Quire only draws its own marks, and the sidecar is the source of truth.
- Search joins text items with a space, so a word split across two items in the PDF does not match the unsplit spelling. Matching is case-insensitive; there is no regex or whole-word option.
- Form fields render as static appearance in the viewer. Filling happens in the Document tab, which handles text, checkbox and list fields; merged-in pages keep their appearance but not necessarily their fields, and flattening a field removes it rather than making it readable as text in every viewer.
- Find & replace paints a cover rectangle over the old glyphs and writes the replacement in Helvetica. The original glyphs stay in the content stream, so a viewer that reads the raw text can still report the old word, and the replacement does not inherit the original font.
- Trim skips rotated pages instead of cropping them wrong, and measures what pdf.js drew — text, images, paths, annotation rects — so a page whose content is only an embedded pattern can be trimmed tighter than intended.
- Saving a document rewrites it through pdf-lib, so the bytes are not identical to the original even when nothing was moved.
- A document operation is undoable (`Ctrl+Z` falls through from marks to document changes) but not redoable; redo only walks the mark list.
- A PDF that needs a password fails to open with a toast; there is no password prompt.
- Ink strokes are stored as point lists with a fixed width, not as pressure data.
- The builds register no file association and no updater. Open a PDF from the command line, by dragging it onto the window, or through the Open dialog.
- The portable exe pays its extraction on every launch; the installer and the zip do not.
- Markdown marks are re-anchored by text after a source edit: a mark whose words survive moves to the block now holding them, and a mark whose words were deleted keeps its note but loses its highlight.
- Markdown source editing writes the file as it stands — no diff, no merge. Editing the same file in another program while Quire has it open means one of the two writes wins.
- `.tex` files are not LaTeX documents. Math only appears inside Markdown, in the four delimiters KaTeX is wired for.
