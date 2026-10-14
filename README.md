# PDF Annotator

A lightweight VS Code PDF annotation extension for research workflows. It keeps the original PDF untouched and stores human annotations as a machine-readable sidecar JSON file next to the PDF.

This repository represents the **v0.1 baseline** and is intentionally versioned as `0.1.0`. If a higher-numbered local development build such as `0.1.4` is already installed, uninstall that development build before installing the final `0.1.0` VSIX.

## v0.1 scope

- Open and read PDFs directly inside VS Code with PDF.js.
- Fast direct PDF loading through a VS Code webview resource URI (no Base64 copy of the PDF).
- Trackpad pinch/Cmd+wheel zoom, plus/minus zoom, fit-width, zoom slider and percentage display.
- Editable page-number field.
- Tool dropdown with keyboard shortcuts:
  - `S` Select / text selection
  - `H` Highlight selected text
  - `U` Underline selected text
  - `P` Pen
  - `E` Eraser
- Fixed annotation color palette plus a custom color picker.
- Machine-readable annotations in `<paper>.annotations.json` next to the PDF.
- Optional `<paper>.annotations.md` created next to the PDF.
- Resizable and collapsible annotation sidebar.
- Annotation comments and deletion.
- Undo/redo for annotation changes.
- Basic PDF text search that indexes the PDF and navigates between pages containing matches.
- Show the JSON sidecar directly in VS Code.
- Explicit Save button in addition to automatic persistence after annotation changes; Save forces the current annotations to the JSON sidecar.

## Files created beside a PDF

For a PDF such as:

```text
paper/
└── paper.pdf
```

PDF Annotator can create:

```text
paper/
├── paper.pdf
├── paper.annotations.json
└── paper.annotations.md   # only after Create Markdown
```

The original PDF is not modified.

## Annotation JSON

The sidecar is intentionally simple and machine-readable. Text annotations store normalized page rectangles and the selected quote. Pen annotations store normalized page points.

New annotations created in v0.1 use:

- `highlight`
- `underline`
- `pen`

The reader still understands older local development annotations such as `strike` and `note` so existing sidecars do not break, but those tools are no longer exposed in the v0.1 UI.

Colors currently have no fixed semantic meaning. The compact palette is intended to make it easy to assign meanings such as priority or review status later without changing the basic annotation workflow.

## Development

```bash
npm install
npm run build
```

Then open the repository in VS Code and run the `Run PDF Annotator` launch configuration, preferably with **Run Without Debugging**.

To build an installable VSIX:

```bash
npm run package
```

This creates a file such as:

```text
pdf-annotator-0.1.0.vsix
```

Install it in VS Code through **Extensions → … → Install from VSIX…**.

## Direction after v0.1

v0.1 is deliberately a general PDF annotator with machine-readable output. A later 1.0 can specialize the workflow for AI-assisted paper analysis, for example with richer derived files, annotation semantics, and agent-facing review artifacts. Those AI-specific functions are intentionally not hard-coded into this baseline.

## License

MIT. PDF rendering uses Mozilla PDF.js (`pdfjs-dist`), which is licensed under Apache-2.0. See `THIRD_PARTY_NOTICES.md`.
