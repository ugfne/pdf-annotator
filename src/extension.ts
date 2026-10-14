import * as vscode from "vscode";
import * as path from "node:path";

import type {
  AnnotationFile,
  AnnotationKind,
  PdfAnnotation
} from "./types";

const VIEW_TYPE = "pdfAnnotator.viewer";

class PdfDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {
    // Nothing to dispose.
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PdfAnnotatorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pdfAnnotator.createMarkdown",
      async (uri?: vscode.Uri) => {
        const target = uri ?? activePdfUri();

        if (!target) {
          vscode.window.showInformationMessage(
            "Open a PDF with PDF Annotator before creating Markdown."
          );
          return;
        }

        await provider.createMarkdown(target);
      }
    )
  );


  context.subscriptions.push(
    vscode.commands.registerCommand(
      "pdfAnnotator.showJson",
      async (uri?: vscode.Uri) => {
        const target = uri ?? activePdfUri();

        if (!target) {
          vscode.window.showInformationMessage(
            "Open a PDF with PDF Annotator before showing annotation JSON."
          );
          return;
        }

        await provider.showJson(target);
      }
    )
  );
}

export function deactivate(): void {
  // Nothing to clean up.
}

function activePdfUri(): vscode.Uri | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;

  if (
    !activeUri ||
    activeUri.scheme !== "file" ||
    !activeUri.path.toLowerCase().endsWith(".pdf")
  ) {
    return undefined;
  }

  return activeUri;
}

class PdfAnnotatorProvider
  implements vscode.CustomReadonlyEditorProvider<PdfDocument>
{
  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
    return new PdfDocument(uri);
  }

  async resolveCustomEditor(
    document: PdfDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;
    const pdfParent = parentUri(document.uri);

    webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri, pdfParent]
    };

    const annotationFile = await readAnnotationFile(document.uri);

    webview.html = this.getHtml(webview, document.uri, annotationFile);

    webview.onDidReceiveMessage(
      async (message: unknown) => {
        if (!isMessage(message)) {
          return;
        }

        if (message.type === "saveAnnotations") {
          const payload = message.payload;

          if (!isAnnotationFile(payload)) {
            vscode.window.showErrorMessage(
              "PDF Annotator received invalid annotation data."
            );
            return;
          }

          await writeAnnotationFile(document.uri, payload);
          return;
        }

        if (message.type === "createMarkdown") {
          const payload = message.payload;

          if (!isAnnotationFile(payload)) {
            vscode.window.showErrorMessage(
              "PDF Annotator received invalid annotation data."
            );
            return;
          }

          await writeAnnotationFile(document.uri, payload);
          const markdown = markdownUri(document.uri);
          await writeMarkdownFile(document.uri, payload);

          vscode.window.showInformationMessage(
            `Created ${path.posix.basename(markdown.path)}`
          );
          return;
        }

        if (message.type === "showJson") {
          const payload = message.payload;

          if (!isAnnotationFile(payload)) {
            vscode.window.showErrorMessage(
              "PDF Annotator received invalid annotation data."
            );
            return;
          }

          await writeAnnotationFile(document.uri, payload);
          await revealFile(sidecarUri(document.uri));
          return;
        }

        if (message.type === "showError") {
          vscode.window.showErrorMessage(
            String(message.message ?? "Unknown PDF Annotator error.")
          );
        }
      },
      undefined,
      this.context.subscriptions
    );
  }

  async createMarkdown(pdfUri: vscode.Uri): Promise<void> {
    const annotations = await readAnnotationFile(pdfUri);
    await writeMarkdownFile(pdfUri, annotations);

    vscode.window.showInformationMessage(
      `Created ${path.posix.basename(markdownUri(pdfUri).path)}`
    );
  }

  async showJson(pdfUri: vscode.Uri): Promise<void> {
    const annotations = await readAnnotationFile(pdfUri);
    await writeAnnotationFile(pdfUri, annotations);
    await revealFile(sidecarUri(pdfUri));
  }

  private getHtml(
    webview: vscode.Webview,
    pdfUri: vscode.Uri,
    annotationFile: AnnotationFile
  ): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );

    const workerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "dist",
        "pdf.worker.min.mjs"
      )
    );

    const viewerCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "dist",
        "pdf_viewer.css"
      )
    );

    const appCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css")
    );

    const pdfWebviewUri = webview.asWebviewUri(pdfUri);

    const annotationsBase64 = Buffer.from(
      JSON.stringify(annotationFile),
      "utf8"
    ).toString("base64");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta
    http-equiv="Content-Security-Policy"
    content="
      default-src 'none';
      img-src ${webview.cspSource} data: blob:;
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src ${webview.cspSource};
      connect-src ${webview.cspSource};
      worker-src ${webview.cspSource} blob:;
      font-src ${webview.cspSource};
    "
  >
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${viewerCssUri}">
  <link rel="stylesheet" href="${appCssUri}">
  <title>PDF Annotator</title>
</head>
<body
  data-pdf-uri="${escapeHtml(pdfWebviewUri.toString())}"
  data-worker-uri="${escapeHtml(workerUri.toString())}"
  data-annotations="${escapeHtml(annotationsBase64)}"
>
  <div id="app">
    <header id="toolbar">
      <div class="menu-anchor tool-menu-anchor">
        <button id="toolMenuButton" class="toolbar-control wide" type="button" aria-haspopup="true" aria-expanded="false">
          <span class="muted-prefix">Tool</span>
          <span id="activeToolShortcut" class="shortcut">S</span>
          <span id="activeToolLabel">Select / text selection</span>
          <span class="chevron">▾</span>
        </button>

        <div id="toolMenu" class="popup-menu tool-menu" hidden>
          <button class="menu-item active" type="button" data-tool="select">
            <span class="shortcut">S</span><span>Select / text selection</span>
          </button>
          <button class="menu-item" type="button" data-tool="highlight">
            <span class="shortcut">H</span><span>Highlight selected text</span>
          </button>
          <button class="menu-item" type="button" data-tool="underline">
            <span class="shortcut">U</span><span>Underline selected text</span>
          </button>
          <button class="menu-item" type="button" data-tool="pen">
            <span class="shortcut">P</span><span>Pen</span>
          </button>
          <button class="menu-item" type="button" data-tool="eraser">
            <span class="shortcut">E</span><span>Eraser</span>
          </button>
        </div>
      </div>

      <div class="menu-anchor color-menu-anchor">
        <button id="colorMenuButton" class="toolbar-control" type="button" aria-haspopup="true" aria-expanded="false">
          <span class="muted-prefix">Color</span>
          <span id="activeColorSwatch" class="color-swatch"></span>
          <span id="activeColorLabel">Yellow</span>
          <span class="chevron">▾</span>
        </button>

        <div id="colorMenu" class="popup-menu color-menu" hidden>
          <div class="menu-heading">Annotation colors</div>
          <div id="colorGrid" class="color-grid">
            <button type="button" class="color-choice selected" data-color="#FFE66D" data-color-name="Yellow" title="Yellow"><span style="background:#FFE66D"></span></button>
            <button type="button" class="color-choice" data-color="#69DB7C" data-color-name="Green" title="Green"><span style="background:#69DB7C"></span></button>
            <button type="button" class="color-choice" data-color="#74C0FC" data-color-name="Blue" title="Blue"><span style="background:#74C0FC"></span></button>
            <button type="button" class="color-choice" data-color="#FFA94D" data-color-name="Orange" title="Orange"><span style="background:#FFA94D"></span></button>
            <button type="button" class="color-choice" data-color="#FF6B6B" data-color-name="Red" title="Red"><span style="background:#FF6B6B"></span></button>
            <button type="button" class="color-choice" data-color="#B197FC" data-color-name="Purple" title="Purple"><span style="background:#B197FC"></span></button>
          </div>
          <div class="menu-divider"></div>
          <button id="moreColorsButton" type="button" class="menu-item simple">
            <span>More colors…</span><span id="customColorPreview" class="small-color-preview"></span>
          </button>
          <input id="customColorInput" type="color" value="#FFE66D" hidden>
        </div>
      </div>

      <span class="separator"></span>

      <button id="zoomOut" class="icon-button" type="button" title="Zoom out">−</button>
      <button id="zoomIn" class="icon-button" type="button" title="Zoom in">+</button>
      <button id="fitWidth" class="toolbar-control compact" type="button" title="Fit width">Fit</button>

      <div class="zoom-slider-wrap" title="Zoom">
        <input id="zoomSlider" type="range" min="25" max="200" step="5" value="100">
        <span id="zoomPercent">100%</span>
      </div>

      <span class="separator"></span>

      <div class="page-control">
        <input id="pageNumberInput" type="number" min="1" value="1" aria-label="Current page">
        <span id="pageTotal">/ –</span>
      </div>

      <span id="selectionStatus" class="status-text">Loading document…</span>
      <span class="spacer"></span>

      <button id="saveButton" class="toolbar-control" type="button" title="Write the current annotations to paper.annotations.json (changes are also auto-saved)">Save</button>

      <div class="menu-anchor more-menu-anchor">
        <button id="moreMenuButton" class="toolbar-control" type="button" aria-haspopup="true" aria-expanded="false">
          More <span class="chevron">▾</span>
        </button>
        <div id="moreMenu" class="popup-menu more-menu" hidden>
          <button id="undoButton" class="menu-item simple" type="button"><span>Undo</span><span class="menu-shortcut">⌘Z</span></button>
          <button id="redoButton" class="menu-item simple" type="button"><span>Redo</span><span class="menu-shortcut">⇧⌘Z</span></button>
          <div class="menu-divider"></div>
          <button id="findButton" class="menu-item simple" type="button"><span>Find in PDF</span><span class="menu-shortcut">⌘F</span></button>
          <div class="menu-divider"></div>
          <button id="showJsonButton" class="menu-item simple" type="button">Show JSON</button>
          <button id="createMarkdownButton" class="menu-item simple" type="button">Create Markdown</button>
        </div>
      </div>
    </header>

    <div id="findBar" hidden>
      <span class="find-label">Find</span>
      <input id="findInput" type="search" autocomplete="off" spellcheck="false" placeholder="Search in PDF">
      <span id="findStatus">0 matches</span>
      <button id="findPrevious" class="icon-button small" type="button" title="Previous match">↑</button>
      <button id="findNext" class="icon-button small" type="button" title="Next match">↓</button>
      <button id="findClose" class="icon-button small" type="button" title="Close search">×</button>
    </div>

    <main id="main">
      <div id="viewerContainer" tabindex="0">
        <div id="viewer" class="pdfViewer"></div>
      </div>

      <div id="sidebarResizer" role="separator" aria-orientation="vertical" aria-label="Resize annotation sidebar">
        <button id="sidebarCollapseButton" type="button" title="Collapse annotation sidebar">›</button>
      </div>

      <aside id="sidebar">
        <div class="sidebar-header">
          <div>
            <h2>Annotation</h2>
            <div id="annotationCount" class="annotation-count">0 annotations</div>
          </div>
          <button id="sidebarCloseButton" class="icon-button small" type="button" title="Collapse sidebar">×</button>
        </div>

        <div id="emptyState">
          Select an annotation to review or edit it. Choose a tool from the toolbar to create new annotations.
        </div>

        <div id="annotationEditor" hidden>
          <div class="field inline-field">
            <label>Type</label>
            <div id="annotationType"></div>
          </div>

          <div class="field inline-field">
            <label>Page</label>
            <div id="annotationPage"></div>
          </div>

          <div id="quoteField" class="field">
            <label>Annotated text</label>
            <blockquote id="annotationQuote"></blockquote>
          </div>

          <div class="field">
            <label for="annotationComment">Comment</label>
            <textarea
              id="annotationComment"
              rows="8"
              placeholder="Add an optional human note for later review or AI-assisted workflows."
            ></textarea>
          </div>

          <div class="actions">
            <button id="saveComment" class="primary" type="button">Save comment</button>
            <button id="deleteAnnotation" class="danger" type="button">Delete annotation</button>
          </div>
        </div>
      </aside>
    </main>

    <div id="toast" role="status" aria-live="polite"></div>
  </div>

  <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  const parentPath = path.posix.dirname(uri.path);

  return uri.with({
    path: parentPath,
    query: "",
    fragment: ""
  });
}

function baseNameWithoutPdf(uri: vscode.Uri): string {
  const fileName = path.posix.basename(uri.path);

  return fileName.toLowerCase().endsWith(".pdf")
    ? fileName.slice(0, -4)
    : fileName;
}

function sidecarUri(pdfUri: vscode.Uri): vscode.Uri {
  const parent = parentUri(pdfUri);

  return parent.with({
    path: path.posix.join(
      parent.path,
      `${baseNameWithoutPdf(pdfUri)}.annotations.json`
    )
  });
}

function markdownUri(pdfUri: vscode.Uri): vscode.Uri {
  const parent = parentUri(pdfUri);

  return parent.with({
    path: path.posix.join(
      parent.path,
      `${baseNameWithoutPdf(pdfUri)}.annotations.md`
    )
  });
}

async function readAnnotationFile(
  pdfUri: vscode.Uri
): Promise<AnnotationFile> {
  const empty: AnnotationFile = {
    schemaVersion: 1,
    pdf: {
      fileName: path.posix.basename(pdfUri.path)
    },
    annotations: []
  };

  try {
    const bytes = await vscode.workspace.fs.readFile(sidecarUri(pdfUri));
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;

    if (isAnnotationFile(parsed)) {
      return parsed;
    }

    vscode.window.showWarningMessage(
      `${baseNameWithoutPdf(pdfUri)}.annotations.json exists but does not match the expected schema. Starting with an empty annotation set.`
    );

    return empty;
  } catch {
    return empty;
  }
}

async function writeAnnotationFile(
  pdfUri: vscode.Uri,
  annotationFile: AnnotationFile
): Promise<void> {
  const normalized: AnnotationFile = {
    schemaVersion: 1,
    pdf: {
      fileName: path.posix.basename(pdfUri.path)
    },
    annotations: annotationFile.annotations
  };

  const bytes = Buffer.from(
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8"
  );

  await vscode.workspace.fs.writeFile(sidecarUri(pdfUri), bytes);
}

async function writeMarkdownFile(
  pdfUri: vscode.Uri,
  annotationFile: AnnotationFile
): Promise<void> {
  const lines: string[] = [
    `# Annotations for ${path.posix.basename(pdfUri.path)}`,
    "",
    "> Human annotations created while reviewing the PDF. The complete PDF remains the primary source; annotations are additional review and priority signals.",
    ""
  ];

  const sorted = [...annotationFile.annotations].sort(
    (a, b) =>
      a.pageNumber - b.pageNumber ||
      a.createdAt.localeCompare(b.createdAt)
  );

  if (sorted.length === 0) {
    lines.push("_No annotations yet._", "");
  } else {
    let currentPage: number | undefined;

    for (const annotation of sorted) {
      if (currentPage !== annotation.pageNumber) {
        currentPage = annotation.pageNumber;
        lines.push(`## Page ${currentPage}`, "");
      }

      const title = annotationKindLabel(annotation.kind);
      lines.push(`### ${title}`, "");

      if (annotation.quote.trim()) {
        lines.push(`> ${annotation.quote.replace(/\n/g, "\n> ")}`, "");
      }

      lines.push(`**Color:** ${annotation.color}`, "");

      if (annotation.comment.trim()) {
        lines.push(`**Comment:** ${annotation.comment.trim()}`, "");
      }
    }
  }

  await vscode.workspace.fs.writeFile(
    markdownUri(pdfUri),
    Buffer.from(`${lines.join("\n")}\n`, "utf8")
  );
}

async function revealFile(uri: vscode.Uri): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: true,
      preserveFocus: false
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not open file: ${message}`);
  }
}

function isMessage(
  value: unknown
): value is {
  type: string;
  payload?: unknown;
  message?: unknown;
} {
  return typeof value === "object" && value !== null && "type" in value;
}

function isAnnotationFile(value: unknown): value is AnnotationFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<AnnotationFile>;

  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.pdf === "object" &&
    candidate.pdf !== null &&
    typeof candidate.pdf.fileName === "string" &&
    Array.isArray(candidate.annotations) &&
    candidate.annotations.every(isAnnotation)
  );
}

function isAnnotation(value: unknown): value is PdfAnnotation {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<PdfAnnotation>;

  return (
    typeof candidate.id === "string" &&
    isAnnotationKind(candidate.kind) &&
    typeof candidate.pageNumber === "number" &&
    typeof candidate.quote === "string" &&
    typeof candidate.comment === "string" &&
    typeof candidate.color === "string" &&
    typeof candidate.opacity === "number" &&
    Array.isArray(candidate.rects) &&
    (candidate.points === undefined || Array.isArray(candidate.points)) &&
    (candidate.strokeWidth === undefined ||
      typeof candidate.strokeWidth === "number") &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

function isAnnotationKind(value: unknown): value is AnnotationKind {
  return (
    value === "highlight" ||
    value === "underline" ||
    value === "strike" ||
    value === "note" ||
    value === "pen"
  );
}

function annotationKindLabel(kind: AnnotationKind): string {
  switch (kind) {
    case "highlight":
      return "Highlight";
    case "underline":
      return "Underline";
    case "strike":
      return "Strike-through";
    case "note":
      return "Note";
    case "pen":
      return "Pen";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
