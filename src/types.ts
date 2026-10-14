export type AnnotationKind =
  | "highlight"
  | "underline"
  | "strike"
  | "note"
  | "pen";

export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface PdfAnnotation {
  id: string;
  kind: AnnotationKind;
  pageNumber: number;
  quote: string;
  comment: string;
  color: string;
  opacity: number;
  rects: AnnotationRect[];
  points?: AnnotationPoint[];
  strokeWidth?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationFile {
  schemaVersion: 1;
  pdf: {
    fileName: string;
  };
  annotations: PdfAnnotation[];
}
