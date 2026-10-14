import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";

import {
  EventBus,
  PDFLinkService,
  PDFViewer
} from "pdfjs-dist/web/pdf_viewer.mjs";

import type {
  AnnotationFile,
  AnnotationKind,
  AnnotationPoint,
  AnnotationRect,
  PdfAnnotation
} from "./types";

type ToolMode =
  | "select"
  | "highlight"
  | "underline"
  | "pen"
  | "eraser";

type PdfDocumentProxy = Awaited<
  ReturnType<typeof pdfjsLib.getDocument>["promise"]
>;

interface UiState {
  sidebarWidth?: number;
  sidebarCollapsed?: boolean;
  activeTool?: string;
  activeColor?: string;
  activeColorName?: string;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): UiState | undefined;
  setState(state: UiState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;

const pdfUri = document.body.dataset.pdfUri;
const workerUri = document.body.dataset.workerUri;
const annotationsEncoded = document.body.dataset.annotations;

if (!pdfUri || !workerUri || !annotationsEncoded) {
  throw new Error("Missing PDF Annotator bootstrap data.");
}

const annotationFile = decodeAnnotationFile(annotationsEncoded);
let annotations = annotationFile.annotations;

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUri;

const viewerContainer = mustGet<HTMLElement>("viewerContainer");
const viewerElement = mustGet<HTMLElement>("viewer");
const main = mustGet<HTMLElement>("main");

const toolMenuButton = mustGet<HTMLButtonElement>("toolMenuButton");
const toolMenu = mustGet<HTMLElement>("toolMenu");
const activeToolShortcut = mustGet<HTMLElement>("activeToolShortcut");
const activeToolLabel = mustGet<HTMLElement>("activeToolLabel");

const colorMenuButton = mustGet<HTMLButtonElement>("colorMenuButton");
const colorMenu = mustGet<HTMLElement>("colorMenu");
const activeColorSwatch = mustGet<HTMLElement>("activeColorSwatch");
const activeColorLabel = mustGet<HTMLElement>("activeColorLabel");
const customColorInput = mustGet<HTMLInputElement>("customColorInput");
const customColorPreview = mustGet<HTMLElement>("customColorPreview");

const zoomSlider = mustGet<HTMLInputElement>("zoomSlider");
const zoomPercent = mustGet<HTMLElement>("zoomPercent");
const pageNumberInput = mustGet<HTMLInputElement>("pageNumberInput");
const pageTotal = mustGet<HTMLElement>("pageTotal");
const selectionStatus = mustGet<HTMLElement>("selectionStatus");

const moreMenuButton = mustGet<HTMLButtonElement>("moreMenuButton");
const moreMenu = mustGet<HTMLElement>("moreMenu");
const undoButton = mustGet<HTMLButtonElement>("undoButton");
const redoButton = mustGet<HTMLButtonElement>("redoButton");

const findBar = mustGet<HTMLElement>("findBar");
const findInput = mustGet<HTMLInputElement>("findInput");
const findStatus = mustGet<HTMLElement>("findStatus");
const findPrevious = mustGet<HTMLButtonElement>("findPrevious");
const findNext = mustGet<HTMLButtonElement>("findNext");
const findClose = mustGet<HTMLButtonElement>("findClose");

const sidebar = mustGet<HTMLElement>("sidebar");
const sidebarResizer = mustGet<HTMLElement>("sidebarResizer");
const sidebarCollapseButton = mustGet<HTMLButtonElement>(
  "sidebarCollapseButton"
);
const sidebarCloseButton = mustGet<HTMLButtonElement>("sidebarCloseButton");
const annotationCount = mustGet<HTMLElement>("annotationCount");

const emptyState = mustGet<HTMLElement>("emptyState");
const annotationEditor = mustGet<HTMLElement>("annotationEditor");
const annotationType = mustGet<HTMLElement>("annotationType");
const annotationPage = mustGet<HTMLElement>("annotationPage");
const quoteField = mustGet<HTMLElement>("quoteField");
const annotationQuote = mustGet<HTMLElement>("annotationQuote");
const annotationComment = mustGet<HTMLTextAreaElement>("annotationComment");
const toast = mustGet<HTMLElement>("toast");

// PDF.js requires the scroll container to be absolutely positioned.
viewerContainer.style.position = "absolute";
viewerContainer.style.top = "0";
viewerContainer.style.left = "0";
viewerContainer.style.bottom = "0";
viewerContainer.style.overflow = "auto";

const savedUiState = vscode.getState() ?? {};
let sidebarWidth = clampNumber(savedUiState.sidebarWidth ?? 340, 260, 620);
let sidebarCollapsed = savedUiState.sidebarCollapsed ?? false;
let activeTool: ToolMode = normalizeToolMode(savedUiState.activeTool);
let activeColor = savedUiState.activeColor ?? "#FFE66D";
let activeColorName = savedUiState.activeColorName ?? "Yellow";

let pendingSelection: {
  pageNumber: number;
  quote: string;
  rects: AnnotationRect[];
} | null = null;

let selectedAnnotationId: string | null = null;
let pdfViewer: PDFViewer;
let pdfDocument: PdfDocumentProxy;

let searchIndex: string[] | null = null;
let searchIndexPromise: Promise<string[]> | null = null;
let searchPages: Array<{ pageNumber: number; count: number }> = [];
let searchPageIndex = -1;
let searchTotalMatches = 0;

let historySnapshots: string[] = [serializeAnnotations()];
let historyIndex = 0;

let activePenPreview: SVGSVGElement | null = null;
let activePenPoints: AnnotationPoint[] | null = null;
let activePenPageNumber: number | null = null;

applySidebarLayout();
setActiveColor(activeColor, activeColorName, false);
setActiveTool(activeTool, false, false);
updateHistoryButtons();

await initialize();

async function initialize(): Promise<void> {
  try {
    pageNumberInput.value = "1";
    pageTotal.textContent = "/ –";
    selectionStatus.textContent = "Loading document…";

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });

    pdfViewer = new PDFViewer({
      container: viewerContainer,
      viewer: viewerElement,
      eventBus,
      linkService,
      textLayerMode: 1
    });

    linkService.setViewer(pdfViewer);

    eventBus.on("pagesinit", () => {
      pdfViewer.currentScaleValue = "page-width";
      updatePageUi();
      updateZoomUi();
      selectionStatus.textContent = toolStatusText(activeTool);
      renderVisibleAnnotations();
      updateInteractionMode();
    });

    eventBus.on("pagechanging", () => {
      updatePageUi();
    });

    eventBus.on(
      "pagerendered",
      ({ pageNumber }: { pageNumber: number }) => {
        renderAnnotationsForPage(pageNumber);
      }
    );

    eventBus.on(
      "textlayerrendered",
      ({ pageNumber }: { pageNumber: number }) => {
        renderAnnotationsForPage(pageNumber);
      }
    );

    eventBus.on("scalechanging", () => {
      window.setTimeout(() => {
        updateZoomUi();
        renderVisibleAnnotations();
      }, 0);
    });

    const loadingTask = pdfjsLib.getDocument({ url: pdfUri });

    loadingTask.onProgress = ({
      loaded,
      total
    }: {
      loaded: number;
      total: number;
    }) => {
      const progress =
        total > 0
          ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100)))
          : undefined;

      selectionStatus.textContent =
        progress === undefined
          ? "Loading PDF…"
          : `Loading PDF… ${progress}%`;
    };

    pdfDocument = await loadingTask.promise;

    pdfViewer.setDocument(pdfDocument);
    linkService.setDocument(pdfDocument);

    wireControls();
    wireMenus();
    wireSelectionCapture();
    wireDrawingTools();
    wireTrackpadZoom();
    wireSidebarResize();
    wireKeyboardShortcuts();
    wireSearch();

    renderAnnotationEditor();
    updateAnnotationCount();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error("PDF Annotator initialization failed:", error);
    selectionStatus.textContent = `PDF load failed: ${message}`;

    vscode.postMessage({
      type: "showError",
      message
    });

    showToast(`Could not open PDF: ${message}`);
  }
}

function wireControls(): void {
  mustGet<HTMLButtonElement>("zoomOut").addEventListener("click", () => {
    setZoom(Math.max(MIN_ZOOM, pdfViewer.currentScale / 1.15));
  });

  mustGet<HTMLButtonElement>("zoomIn").addEventListener("click", () => {
    setZoom(Math.min(MAX_ZOOM, pdfViewer.currentScale * 1.15));
  });

  mustGet<HTMLButtonElement>("fitWidth").addEventListener("click", () => {
    pdfViewer.currentScaleValue = "page-width";
    window.setTimeout(updateZoomUi, 0);
  });

  zoomSlider.addEventListener("input", () => {
    const percent = Number(zoomSlider.value);

    if (Number.isFinite(percent)) {
      setZoom(percent / 100);
    }
  });

  pageNumberInput.addEventListener("change", () => {
    jumpToPageFromInput();
  });

  pageNumberInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      jumpToPageFromInput();
      viewerContainer.focus();
    }
  });

  mustGet<HTMLButtonElement>("saveButton").addEventListener("click", () => {
    persist();
    showToast("Annotations saved to JSON.");
  });

  mustGet<HTMLButtonElement>("saveComment").addEventListener("click", () => {
    const annotation = selectedAnnotation();

    if (!annotation) {
      return;
    }

    annotation.comment = annotationComment.value;
    annotation.updatedAt = new Date().toISOString();

    commitAnnotationChange();
    renderAnnotationEditor();
    showToast("Comment saved.");
  });

  mustGet<HTMLButtonElement>("deleteAnnotation").addEventListener(
    "click",
    () => {
      deleteSelectedAnnotation();
    }
  );

  mustGet<HTMLButtonElement>("createMarkdownButton").addEventListener(
    "click",
    () => {
      closeAllMenus();
      vscode.postMessage({
        type: "createMarkdown",
        payload: currentAnnotationFile()
      });
      showToast("Creating Markdown…");
    }
  );

  mustGet<HTMLButtonElement>("showJsonButton").addEventListener(
    "click",
    () => {
      closeAllMenus();
      vscode.postMessage({
        type: "showJson",
        payload: currentAnnotationFile()
      });
    }
  );

  undoButton.addEventListener("click", () => {
    closeAllMenus();
    undo();
  });

  redoButton.addEventListener("click", () => {
    closeAllMenus();
    redo();
  });
}

function wireMenus(): void {
  toolMenuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu(toolMenu, toolMenuButton);
  });

  colorMenuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu(colorMenu, colorMenuButton);
  });

  moreMenuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu(moreMenu, moreMenuButton);
  });

  toolMenu.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach(
    (button) => {
      button.addEventListener("click", () => {
        const tool = button.dataset.tool as ToolMode | undefined;

        if (!tool) {
          return;
        }

        setActiveTool(tool, true, true);
        closeAllMenus();
      });
    }
  );

  colorMenu.querySelectorAll<HTMLButtonElement>("[data-color]").forEach(
    (button) => {
      button.addEventListener("click", () => {
        const color = button.dataset.color;
        const name = button.dataset.colorName;

        if (!color || !name) {
          return;
        }

        setActiveColor(color, name, true);
        closeAllMenus();
      });
    }
  );

  mustGet<HTMLButtonElement>("moreColorsButton").addEventListener(
    "click",
    () => {
      customColorInput.click();
    }
  );

  customColorInput.addEventListener("input", () => {
    setActiveColor(customColorInput.value, "Custom", true);
  });

  customColorInput.addEventListener("change", () => {
    closeAllMenus();
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Node;

    if (
      !toolMenu.contains(target) &&
      !toolMenuButton.contains(target) &&
      !colorMenu.contains(target) &&
      !colorMenuButton.contains(target) &&
      !moreMenu.contains(target) &&
      !moreMenuButton.contains(target)
    ) {
      closeAllMenus();
    }
  });
}

function toggleMenu(menu: HTMLElement, button: HTMLButtonElement): void {
  const shouldOpen = menu.hidden;
  closeAllMenus();
  menu.hidden = !shouldOpen;
  button.setAttribute("aria-expanded", String(shouldOpen));
}

function closeAllMenus(): void {
  toolMenu.hidden = true;
  colorMenu.hidden = true;
  moreMenu.hidden = true;
  toolMenuButton.setAttribute("aria-expanded", "false");
  colorMenuButton.setAttribute("aria-expanded", "false");
  moreMenuButton.setAttribute("aria-expanded", "false");
}

function setActiveTool(
  tool: ToolMode,
  persistUi: boolean,
  applyPendingSelection: boolean
): void {
  activeTool = tool;
  const metadata = toolMetadata(tool);

  activeToolShortcut.textContent = metadata.shortcut;
  activeToolLabel.textContent = metadata.label;

  toolMenu.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach(
    (button) => {
      button.classList.toggle("active", button.dataset.tool === tool);
    }
  );

  viewerContainer.classList.toggle("drawing-tool", tool === "pen");
  viewerContainer.classList.toggle("eraser-tool", tool === "eraser");

  selectionStatus.textContent = toolStatusText(tool);
  updateInteractionMode();

  if (
    applyPendingSelection &&
    pendingSelection &&
    (tool === "highlight" || tool === "underline")
  ) {
    createTextAnnotation(tool, pendingSelection);
  }

  if (persistUi) {
    persistUiState();
  }
}

function setActiveColor(color: string, name: string, persistUi: boolean): void {
  activeColor = color;
  activeColorName = name;
  activeColorSwatch.style.background = color;
  activeColorLabel.textContent = name;
  customColorInput.value = color;
  customColorPreview.style.background = color;

  colorMenu.querySelectorAll<HTMLButtonElement>("[data-color]").forEach(
    (button) => {
      button.classList.toggle("selected", button.dataset.color === color);
    }
  );

  if (persistUi) {
    persistUiState();
  }
}

function normalizeToolMode(value: unknown): ToolMode {
  switch (value) {
    case "select":
    case "highlight":
    case "underline":
    case "pen":
    case "eraser":
      return value;
    default:
      return "select";
  }
}

function toolMetadata(tool: ToolMode): { shortcut: string; label: string } {
  switch (tool) {
    case "select":
      return { shortcut: "S", label: "Select / text selection" };
    case "highlight":
      return { shortcut: "H", label: "Highlight selected text" };
    case "underline":
      return { shortcut: "U", label: "Underline selected text" };
    case "pen":
      return { shortcut: "P", label: "Pen" };
    case "eraser":
      return { shortcut: "E", label: "Eraser" };
  }
}

function toolStatusText(tool: ToolMode): string {
  switch (tool) {
    case "select":
      return "Select text or an annotation";
    case "highlight":
      return "Drag over text to highlight it";
    case "underline":
      return "Drag over text to underline it";
    case "pen":
      return "Draw directly on the PDF";
    case "eraser":
      return "Click an annotation to delete it";
  }
}

function wireSelectionCapture(): void {
  viewerContainer.addEventListener("mouseup", () => {
    if (
      activeTool !== "select" &&
      activeTool !== "highlight" &&
      activeTool !== "underline"
    ) {
      return;
    }

    window.setTimeout(() => {
      pendingSelection = captureSelection();
      const tool = activeTool;

      if (!pendingSelection) {
        if (tool === "select") {
          selectionStatus.textContent = toolStatusText(tool);
        }
        return;
      }

      if (tool === "select") {
        updateSelectionStatus();
        return;
      }

      if (tool === "highlight" || tool === "underline") {
        createTextAnnotation(tool, pendingSelection);
      }
    }, 0);
  });
}

function createTextAnnotation(
  kind: "highlight" | "underline",
  selection: {
    pageNumber: number;
    quote: string;
    rects: AnnotationRect[];
  }
): void {
  const now = new Date().toISOString();
  const annotation: PdfAnnotation = {
    id: crypto.randomUUID(),
    kind,
    pageNumber: selection.pageNumber,
    quote: selection.quote,
    comment: "",
    color: activeColor,
    opacity: kind === "highlight" ? 0.38 : 1,
    rects: selection.rects,
    createdAt: now,
    updatedAt: now
  };

  annotations.push(annotation);
  selectedAnnotationId = annotation.id;
  pendingSelection = null;
  window.getSelection()?.removeAllRanges();

  commitAnnotationChange();
  renderAnnotationsForPage(annotation.pageNumber);
  renderAnnotationEditor();
  updateAnnotationCount();
  selectionStatus.textContent = toolStatusText(activeTool);
}

function wireDrawingTools(): void {
  viewerContainer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    if (activeTool !== "pen") {
      return;
    }

    const page = closestPage(event.target);

    if (!page) {
      return;
    }

    const pageNumber = Number(page.dataset.pageNumber);
    const point = pointOnPage(event, page);

    if (!Number.isFinite(pageNumber) || !point) {
      return;
    }

    event.preventDefault();
    activePenPoints = [point];
    activePenPageNumber = pageNumber;
    activePenPreview = createPenPreview(page, activeColor);
    updatePenPreview(activePenPreview, activePenPoints);

    const onMove = (moveEvent: PointerEvent) => {
      if (!activePenPoints || activePenPageNumber !== pageNumber) {
        return;
      }

      const nextPoint = pointOnPage(moveEvent, page);

      if (!nextPoint) {
        return;
      }

      const previous = activePenPoints[activePenPoints.length - 1];
      const dx = nextPoint.x - previous.x;
      const dy = nextPoint.y - previous.y;

      if (Math.hypot(dx, dy) < 0.0015) {
        return;
      }

      activePenPoints.push(nextPoint);

      if (activePenPreview) {
        updatePenPreview(activePenPreview, activePenPoints);
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      finishPenStroke(pageNumber);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  });
}

function finishPenStroke(pageNumber: number): void {
  activePenPreview?.remove();

  const points = activePenPoints;
  activePenPreview = null;
  activePenPoints = null;
  activePenPageNumber = null;

  if (!points || points.length < 2) {
    return;
  }

  const now = new Date().toISOString();
  const annotation: PdfAnnotation = {
    id: crypto.randomUUID(),
    kind: "pen",
    pageNumber,
    quote: "",
    comment: "",
    color: activeColor,
    opacity: 1,
    rects: [],
    points,
    strokeWidth: 2.4,
    createdAt: now,
    updatedAt: now
  };

  annotations.push(annotation);
  selectedAnnotationId = annotation.id;
  commitAnnotationChange();
  renderAnnotationsForPage(pageNumber);
  renderAnnotationEditor();
  updateAnnotationCount();
}

function createPenPreview(page: HTMLElement, color: string): SVGSVGElement {
  const layer = ensureAnnotationLayer(page);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("pen-preview");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "none");

  const polyline = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "polyline"
  );
  polyline.setAttribute("fill", "none");
  polyline.setAttribute("stroke", color);
  polyline.setAttribute("stroke-width", "2.4");
  polyline.setAttribute("stroke-linecap", "round");
  polyline.setAttribute("stroke-linejoin", "round");
  polyline.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(polyline);
  layer.appendChild(svg);

  return svg;
}

function updatePenPreview(
  svg: SVGSVGElement,
  points: AnnotationPoint[]
): void {
  const polyline = svg.querySelector("polyline");

  if (!polyline) {
    return;
  }

  polyline.setAttribute(
    "points",
    points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(" ")
  );
}

function wireTrackpadZoom(): void {
  viewerContainer.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) {
        return;
      }

      event.preventDefault();

      const oldScale = pdfViewer.currentScale;

      if (!Number.isFinite(oldScale) || oldScale <= 0) {
        return;
      }

      const zoomFactor = Math.exp(-event.deltaY * 0.01);
      const newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldScale * zoomFactor));

      if (Math.abs(newScale - oldScale) < 0.001) {
        return;
      }

      const containerRect = viewerContainer.getBoundingClientRect();
      const pointerX = event.clientX - containerRect.left;
      const pointerY = event.clientY - containerRect.top;
      const contentX = viewerContainer.scrollLeft + pointerX;
      const contentY = viewerContainer.scrollTop + pointerY;
      const ratio = newScale / oldScale;

      pdfViewer.currentScale = newScale;

      requestAnimationFrame(() => {
        viewerContainer.scrollLeft = contentX * ratio - pointerX;
        viewerContainer.scrollTop = contentY * ratio - pointerY;
        updateZoomUi();
      });
    },
    { passive: false }
  );
}

function wireSidebarResize(): void {
  sidebarCollapseButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSidebar();
  });

  sidebarCloseButton.addEventListener("click", () => {
    collapseSidebar();
  });

  sidebarResizer.addEventListener("pointerdown", (event) => {
    if ((event.target as Element).closest("button")) {
      return;
    }

    event.preventDefault();
    document.body.classList.add("resizing-sidebar");

    const onMove = (moveEvent: PointerEvent) => {
      const width = window.innerWidth - moveEvent.clientX;

      if (width < 90) {
        sidebarCollapsed = true;
      } else {
        sidebarCollapsed = false;
        sidebarWidth = clampNumber(width, 260, Math.min(620, window.innerWidth * 0.55));
      }

      applySidebarLayout(false);
    };

    const onUp = () => {
      document.body.classList.remove("resizing-sidebar");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persistUiState();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  });
}

function toggleSidebar(): void {
  sidebarCollapsed = !sidebarCollapsed;
  applySidebarLayout();
}

function collapseSidebar(): void {
  sidebarCollapsed = true;
  applySidebarLayout();
}

function expandSidebar(): void {
  if (!sidebarCollapsed) {
    return;
  }

  sidebarCollapsed = false;
  applySidebarLayout();
}

function applySidebarLayout(persistState = true): void {
  main.style.setProperty(
    "--sidebar-width",
    sidebarCollapsed ? "0px" : `${sidebarWidth}px`
  );
  main.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  sidebar.setAttribute("aria-hidden", String(sidebarCollapsed));
  sidebarCollapseButton.textContent = sidebarCollapsed ? "‹" : "›";
  sidebarCollapseButton.title = sidebarCollapsed
    ? "Show annotation sidebar"
    : "Collapse annotation sidebar";

  if (persistState) {
    persistUiState();
  }
}

function wireKeyboardShortcuts(): void {
  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.isContentEditable;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFindBar();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      if (typing && target !== viewerContainer) {
        return;
      }

      event.preventDefault();

      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }

    if (event.key === "Escape") {
      closeAllMenus();

      if (!findBar.hidden) {
        closeFindBar();
        return;
      }

      pendingSelection = null;
      window.getSelection()?.removeAllRanges();
      selectionStatus.textContent = toolStatusText(activeTool);
      return;
    }

    if (
      (event.key === "Delete" || event.key === "Backspace") &&
      selectedAnnotationId &&
      !typing
    ) {
      event.preventDefault();
      deleteSelectedAnnotation();
      return;
    }

    if (typing || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    const shortcutMap: Record<string, ToolMode> = {
      s: "select",
      h: "highlight",
      u: "underline",
      p: "pen",
      e: "eraser"
    };

    const tool = shortcutMap[event.key.toLowerCase()];

    if (tool) {
      event.preventDefault();
      setActiveTool(tool, true, true);
    }
  });
}

function wireSearch(): void {
  mustGet<HTMLButtonElement>("findButton").addEventListener("click", () => {
    closeAllMenus();
    openFindBar();
  });

  findClose.addEventListener("click", closeFindBar);

  findInput.addEventListener("input", () => {
    void runSearch(findInput.value);
  });

  findInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();

      if (event.shiftKey) {
        goToSearchResult(-1);
      } else {
        goToSearchResult(1);
      }
    }
  });

  findPrevious.addEventListener("click", () => goToSearchResult(-1));
  findNext.addEventListener("click", () => goToSearchResult(1));
}

function openFindBar(): void {
  findBar.hidden = false;
  findInput.focus();
  findInput.select();
}

function closeFindBar(): void {
  findBar.hidden = true;
  findInput.blur();
  viewerContainer.focus();
}

async function runSearch(queryRaw: string): Promise<void> {
  const query = queryRaw.trim().toLocaleLowerCase();

  if (!query) {
    searchPages = [];
    searchPageIndex = -1;
    searchTotalMatches = 0;
    findStatus.textContent = "0 matches";
    return;
  }

  findStatus.textContent = "Searching…";

  const indexedPages = await getSearchIndex();

  if (findInput.value.trim().toLocaleLowerCase() !== query) {
    return;
  }

  searchPages = [];
  searchTotalMatches = 0;

  indexedPages.forEach((pageText, index) => {
    const count = countOccurrences(pageText, query);

    if (count > 0) {
      searchPages.push({ pageNumber: index + 1, count });
      searchTotalMatches += count;
    }
  });

  if (searchPages.length === 0) {
    searchPageIndex = -1;
    findStatus.textContent = "No matches";
    return;
  }

  const currentPage = pdfViewer.currentPageNumber;
  const currentMatchIndex = searchPages.findIndex(
    (item) => item.pageNumber >= currentPage
  );
  searchPageIndex = currentMatchIndex >= 0 ? currentMatchIndex : 0;
  jumpToSearchPage();
}


async function getSearchIndex(): Promise<string[]> {
  if (searchIndex) {
    return searchIndex;
  }

  if (!searchIndexPromise) {
    searchIndexPromise = (async () => {
      const pages: string[] = [];

      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
        const page = await pdfDocument.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? String(item.str) : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .toLocaleLowerCase();
        pages.push(text);
      }

      searchIndex = pages;
      return pages;
    })();
  }

  return searchIndexPromise;
}

function goToSearchResult(direction: 1 | -1): void {
  if (searchPages.length === 0) {
    return;
  }

  searchPageIndex =
    (searchPageIndex + direction + searchPages.length) % searchPages.length;
  jumpToSearchPage();
}

function jumpToSearchPage(): void {
  if (searchPageIndex < 0 || searchPageIndex >= searchPages.length) {
    return;
  }

  const result = searchPages[searchPageIndex];
  pdfViewer.currentPageNumber = result.pageNumber;
  findStatus.textContent = `${searchPageIndex + 1}/${searchPages.length} pages · ${searchTotalMatches} matches`;
}

function countOccurrences(text: string, query: string): number {
  let count = 0;
  let index = 0;

  while (true) {
    index = text.indexOf(query, index);

    if (index < 0) {
      return count;
    }

    count += 1;
    index += Math.max(1, query.length);
  }
}

function captureSelection(): {
  pageNumber: number;
  quote: string;
  rects: AnnotationRect[];
} | null {
  const selection = window.getSelection();

  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const quote = normalizeSelectedText(selection.toString());

  if (!quote) {
    return null;
  }

  const range = selection.getRangeAt(0);

  const startElement =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;

  const endElement =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as Element)
      : range.endContainer.parentElement;

  const startPage = startElement?.closest<HTMLElement>(".page");
  const endPage = endElement?.closest<HTMLElement>(".page");

  if (!startPage || !endPage || startPage !== endPage) {
    showToast("For now, create text annotations within a single page.");
    return null;
  }

  const pageNumber = Number(startPage.dataset.pageNumber);

  if (!Number.isFinite(pageNumber)) {
    return null;
  }

  const pageRect = startPage.getBoundingClientRect();
  const rects: AnnotationRect[] = [];
  const textSpans = Array.from(
    startPage.querySelectorAll<HTMLElement>(".textLayer span")
  );

  for (const span of textSpans) {
    if (!span.textContent?.trim()) {
      continue;
    }

    try {
      if (!range.intersectsNode(span)) {
        continue;
      }
    } catch {
      continue;
    }

    const overlapRange = createRangeOverlap(range, span);

    if (!overlapRange) {
      continue;
    }

    for (const clientRect of Array.from(overlapRange.getClientRects())) {
      const normalized = normalizeRectToPage(clientRect, pageRect);

      if (normalized) {
        rects.push(normalized);
      }
    }

    overlapRange.detach();
  }

  if (rects.length === 0) {
    for (const clientRect of Array.from(range.getClientRects())) {
      const normalized = normalizeRectToPage(clientRect, pageRect);

      if (normalized) {
        rects.push(normalized);
      }
    }
  }

  const mergedRects = mergeSelectionRects(rects);

  if (mergedRects.length === 0) {
    return null;
  }

  return {
    pageNumber,
    quote,
    rects: mergedRects
  };
}

function renderVisibleAnnotations(): void {
  viewerElement
    .querySelectorAll<HTMLElement>(".page[data-page-number]")
    .forEach((page) => {
      const pageNumber = Number(page.dataset.pageNumber);

      if (Number.isFinite(pageNumber)) {
        renderAnnotationsForPage(pageNumber);
      }
    });
}

function renderAnnotationsForPage(pageNumber: number): void {
  const page = viewerElement.querySelector<HTMLElement>(
    `.page[data-page-number="${pageNumber}"]`
  );

  if (!page) {
    return;
  }

  const layer = ensureAnnotationLayer(page);
  layer.replaceChildren();

  const pageAnnotations = annotations.filter(
    (annotation) => annotation.pageNumber === pageNumber
  );

  for (const annotation of pageAnnotations) {
    switch (annotation.kind) {
      case "highlight":
        renderHighlight(layer, annotation);
        break;
      case "underline":
        renderTextLine(layer, annotation, "underline");
        break;
      case "strike":
        renderTextLine(layer, annotation, "strike");
        break;
      case "note":
        renderNote(layer, annotation);
        break;
      case "pen":
        renderPen(layer, annotation);
        break;
    }
  }

  updateInteractionMode();
}

function ensureAnnotationLayer(page: HTMLElement): HTMLElement {
  let layer = page.querySelector<HTMLElement>(".humanAnnotationLayer");

  if (!layer) {
    layer = document.createElement("div");
    layer.className = "humanAnnotationLayer";
    page.appendChild(layer);
  }

  layer.style.left = "0";
  layer.style.top = "0";
  layer.style.width = "100%";
  layer.style.height = "100%";

  return layer;
}

function renderHighlight(layer: HTMLElement, annotation: PdfAnnotation): void {
  annotation.rects.forEach((storedRect) => {
    const rect = tightenHighlightRect(storedRect);
    const element = document.createElement("button");
    element.type = "button";
    element.className = "humanAnnotation humanHighlight";
    placeRectElement(element, rect);
    element.style.background = annotation.color;
    element.style.opacity = String(annotation.opacity);
    configureAnnotationElement(element, annotation);
    layer.appendChild(element);
  });
}

function renderTextLine(
  layer: HTMLElement,
  annotation: PdfAnnotation,
  mode: "underline" | "strike"
): void {
  annotation.rects.forEach((rect) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `humanAnnotation humanTextLine ${mode}`;
    placeRectElement(element, rect);
    element.style.setProperty("--annotation-color", annotation.color);
    configureAnnotationElement(element, annotation);
    layer.appendChild(element);
  });
}

function renderNote(layer: HTMLElement, annotation: PdfAnnotation): void {
  const rect = annotation.rects[0];

  if (!rect) {
    return;
  }

  const element = document.createElement("button");
  element.type = "button";
  element.className = "humanAnnotation humanNote";
  element.textContent = "N";
  placeRectElement(element, rect);
  element.style.background = annotation.color;
  element.title = annotation.comment || "Note";
  configureAnnotationElement(element, annotation);
  layer.appendChild(element);
}

function renderPen(layer: HTMLElement, annotation: PdfAnnotation): void {
  if (!annotation.points || annotation.points.length < 2) {
    return;
  }

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("humanAnnotation", "humanPen");
  svg.dataset.annotationId = annotation.id;
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.setAttribute("preserveAspectRatio", "none");

  const polyline = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "polyline"
  );
  polyline.setAttribute("fill", "none");
  polyline.setAttribute("stroke", annotation.color);
  polyline.setAttribute("stroke-width", String(annotation.strokeWidth ?? 2.4));
  polyline.setAttribute("stroke-linecap", "round");
  polyline.setAttribute("stroke-linejoin", "round");
  polyline.setAttribute("vector-effect", "non-scaling-stroke");
  polyline.setAttribute(
    "points",
    annotation.points
      .map((point) => `${point.x * 1000},${point.y * 1000}`)
      .join(" ")
  );

  if (annotation.id === selectedAnnotationId) {
    svg.classList.add("selected");
  }

  polyline.addEventListener("click", (event) => {
    handleAnnotationClick(event, annotation);
  });

  svg.appendChild(polyline);
  layer.appendChild(svg);
}

function configureAnnotationElement(
  element: HTMLElement,
  annotation: PdfAnnotation
): void {
  element.dataset.annotationId = annotation.id;
  element.title = annotation.comment
    ? `${annotation.quote || annotationKindLabel(annotation.kind)}\n\nComment: ${annotation.comment}`
    : annotation.quote || annotationKindLabel(annotation.kind);

  if (annotation.id === selectedAnnotationId) {
    element.classList.add("selected");
  }

  element.addEventListener("click", (event) => {
    handleAnnotationClick(event, annotation);
  });
}

function handleAnnotationClick(event: Event, annotation: PdfAnnotation): void {
  event.preventDefault();
  event.stopPropagation();

  if (activeTool === "eraser") {
    deleteAnnotation(annotation.id);
    return;
  }

  selectedAnnotationId = annotation.id;
  renderAnnotationEditor();
  renderAnnotationsForPage(annotation.pageNumber);
  expandSidebar();
}

function placeRectElement(element: HTMLElement, rect: AnnotationRect): void {
  element.style.left = `${rect.x * 100}%`;
  element.style.top = `${rect.y * 100}%`;
  element.style.width = `${rect.width * 100}%`;
  element.style.height = `${rect.height * 100}%`;
}

function renderAnnotationEditor(): void {
  const annotation = selectedAnnotation();

  updateAnnotationCount();

  if (!annotation) {
    emptyState.hidden = false;
    annotationEditor.hidden = true;
    return;
  }

  emptyState.hidden = true;
  annotationEditor.hidden = false;
  annotationType.textContent = annotationKindLabel(annotation.kind);
  annotationPage.textContent = String(annotation.pageNumber);
  quoteField.hidden = !annotation.quote.trim();
  annotationQuote.textContent = annotation.quote;
  annotationComment.value = annotation.comment;
}

function selectedAnnotation(): PdfAnnotation | undefined {
  return annotations.find((item) => item.id === selectedAnnotationId);
}

function deleteSelectedAnnotation(): void {
  if (!selectedAnnotationId) {
    return;
  }

  deleteAnnotation(selectedAnnotationId);
}

function deleteAnnotation(id: string): void {
  const annotation = annotations.find((item) => item.id === id);

  if (!annotation) {
    return;
  }

  annotations = annotations.filter((item) => item.id !== id);

  if (selectedAnnotationId === id) {
    selectedAnnotationId = null;
  }

  commitAnnotationChange();
  renderAnnotationsForPage(annotation.pageNumber);
  renderAnnotationEditor();
  updateAnnotationCount();
  showToast("Annotation deleted.");
}

function updateAnnotationCount(): void {
  const count = annotations.length;
  annotationCount.textContent = `${count} annotation${count === 1 ? "" : "s"}`;
}

function updateInteractionMode(): void {
  const interactiveCanvas =
    activeTool === "pen" || activeTool === "eraser";

  viewerElement
    .querySelectorAll<HTMLElement>(".humanAnnotationLayer")
    .forEach((layer) => {
      layer.classList.toggle("canvas-interactive", interactiveCanvas);
    });
}

function updatePageUi(): void {
  const current = pdfViewer.currentPageNumber || 1;
  const total = pdfViewer.pagesCount || 0;

  pageNumberInput.value = String(current);
  pageNumberInput.max = String(Math.max(total, 1));
  pageTotal.textContent = `/ ${total || "–"}`;
}

function jumpToPageFromInput(): void {
  const total = pdfViewer.pagesCount || 1;
  const requested = Number(pageNumberInput.value);
  const page = Number.isFinite(requested)
    ? Math.round(clampNumber(requested, 1, total))
    : pdfViewer.currentPageNumber;

  pdfViewer.currentPageNumber = page;
  updatePageUi();
}

function setZoom(scale: number): void {
  if (!Number.isFinite(scale)) {
    return;
  }

  pdfViewer.currentScale = clampNumber(scale, MIN_ZOOM, MAX_ZOOM);
  updateZoomUi();
}

function updateZoomUi(): void {
  const scale = pdfViewer.currentScale;

  if (!Number.isFinite(scale) || scale <= 0) {
    return;
  }

  const percent = Math.round(scale * 100);
  zoomPercent.textContent = `${percent}%`;
  zoomSlider.value = String(clampNumber(percent, MIN_ZOOM * 100, MAX_ZOOM * 100));
}

function updateSelectionStatus(): void {
  if (!pendingSelection) {
    selectionStatus.textContent = toolStatusText(activeTool);
    return;
  }

  const preview =
    pendingSelection.quote.length > 58
      ? `${pendingSelection.quote.slice(0, 55)}…`
      : pendingSelection.quote;

  selectionStatus.textContent = `Selected: “${preview}”`;
}

function commitAnnotationChange(): void {
  const snapshot = serializeAnnotations();

  if (historySnapshots[historyIndex] !== snapshot) {
    historySnapshots = historySnapshots.slice(0, historyIndex + 1);
    historySnapshots.push(snapshot);
    historyIndex = historySnapshots.length - 1;
  }

  persist();
  updateHistoryButtons();
}

function undo(): void {
  if (historyIndex <= 0) {
    return;
  }

  historyIndex -= 1;
  restoreHistorySnapshot();
  showToast("Undone.");
}

function redo(): void {
  if (historyIndex >= historySnapshots.length - 1) {
    return;
  }

  historyIndex += 1;
  restoreHistorySnapshot();
  showToast("Redone.");
}

function restoreHistorySnapshot(): void {
  annotations = JSON.parse(historySnapshots[historyIndex]) as PdfAnnotation[];

  if (
    selectedAnnotationId &&
    !annotations.some((annotation) => annotation.id === selectedAnnotationId)
  ) {
    selectedAnnotationId = null;
  }

  persist();
  updateHistoryButtons();
  renderVisibleAnnotations();
  renderAnnotationEditor();
  updateAnnotationCount();
}

function updateHistoryButtons(): void {
  undoButton.disabled = historyIndex <= 0;
  redoButton.disabled = historyIndex >= historySnapshots.length - 1;
}

function serializeAnnotations(): string {
  return JSON.stringify(annotations);
}

function persist(): void {
  vscode.postMessage({
    type: "saveAnnotations",
    payload: currentAnnotationFile()
  });
}

function currentAnnotationFile(): AnnotationFile {
  return {
    schemaVersion: 1,
    pdf: annotationFile.pdf,
    annotations
  };
}

function persistUiState(): void {
  vscode.setState({
    sidebarWidth,
    sidebarCollapsed,
    activeTool,
    activeColor,
    activeColorName
  });
}

function closestPage(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(".page") : null;
}

function pointOnPage(
  event: PointerEvent,
  page: HTMLElement
): AnnotationPoint | null {
  const rect = page.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  return {
    x: clamp01((event.clientX - rect.left) / rect.width),
    y: clamp01((event.clientY - rect.top) / rect.height)
  };
}

function decodeAnnotationFile(encoded: string): AnnotationFile {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as AnnotationFile;
}

function createRangeOverlap(
  selectionRange: Range,
  span: HTMLElement
): Range | null {
  const spanRange = document.createRange();
  spanRange.selectNodeContents(span);

  const overlap = document.createRange();

  try {
    if (span.contains(selectionRange.startContainer)) {
      overlap.setStart(selectionRange.startContainer, selectionRange.startOffset);
    } else {
      overlap.setStart(spanRange.startContainer, spanRange.startOffset);
    }

    if (span.contains(selectionRange.endContainer)) {
      overlap.setEnd(selectionRange.endContainer, selectionRange.endOffset);
    } else {
      overlap.setEnd(spanRange.endContainer, spanRange.endOffset);
    }
  } catch {
    spanRange.detach();
    overlap.detach();
    return null;
  }

  spanRange.detach();

  if (overlap.collapsed || !overlap.toString().trim()) {
    overlap.detach();
    return null;
  }

  return overlap;
}

function normalizeRectToPage(
  clientRect: DOMRect,
  pageRect: DOMRect
): AnnotationRect | null {
  if (
    clientRect.width < 0.5 ||
    clientRect.height < 0.5 ||
    pageRect.width <= 0 ||
    pageRect.height <= 0
  ) {
    return null;
  }

  const left = Math.max(clientRect.left, pageRect.left);
  const top = Math.max(clientRect.top, pageRect.top);
  const right = Math.min(clientRect.right, pageRect.right);
  const bottom = Math.min(clientRect.bottom, pageRect.bottom);

  if (right <= left || bottom <= top) {
    return null;
  }

  return {
    x: clamp01((left - pageRect.left) / pageRect.width),
    y: clamp01((top - pageRect.top) / pageRect.height),
    width: clamp01((right - left) / pageRect.width),
    height: clamp01((bottom - top) / pageRect.height)
  };
}

function mergeSelectionRects(rects: AnnotationRect[]): AnnotationRect[] {
  const sorted = [...rects].sort((a, b) => {
    const aCenter = a.y + a.height / 2;
    const bCenter = b.y + b.height / 2;

    if (Math.abs(aCenter - bCenter) > 0.006) {
      return aCenter - bCenter;
    }

    return a.x - b.x;
  });

  const merged: AnnotationRect[] = [];

  for (const rect of sorted) {
    const previous = merged[merged.length - 1];

    if (!previous || !rectsShareLine(previous, rect)) {
      merged.push({ ...rect });
      continue;
    }

    const previousRight = previous.x + previous.width;
    const gap = rect.x - previousRight;

    if (gap > 0.018) {
      merged.push({ ...rect });
      continue;
    }

    const left = Math.min(previous.x, rect.x);
    const top = Math.min(previous.y, rect.y);
    const right = Math.max(previousRight, rect.x + rect.width);
    const bottom = Math.max(
      previous.y + previous.height,
      rect.y + rect.height
    );

    previous.x = left;
    previous.y = top;
    previous.width = clamp01(right - left);
    previous.height = clamp01(bottom - top);
  }

  return merged;
}

function rectsShareLine(a: AnnotationRect, b: AnnotationRect): boolean {
  const aCenter = a.y + a.height / 2;
  const bCenter = b.y + b.height / 2;
  const lineHeight = Math.max(a.height, b.height, 0.001);

  return Math.abs(aCenter - bCenter) <= lineHeight * 0.55;
}

function tightenHighlightRect(rect: AnnotationRect): AnnotationRect {
  const verticalInset = rect.height * 0.22;
  const maximumHeight = 0.028;
  const minimumHeight = 0.003;

  const tightenedHeight = Math.max(
    minimumHeight,
    Math.min(rect.height - verticalInset * 2, maximumHeight)
  );

  return {
    x: rect.x,
    y: clamp01(rect.y + (rect.height - tightenedHeight) / 2),
    width: rect.width,
    height: Math.min(tightenedHeight, 1 - rect.y)
  };
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

function normalizeSelectedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add("visible");

  window.setTimeout(() => {
    toast.classList.remove("visible");
  }, 2200);
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing element #${id}`);
  }

  return element as T;
}
