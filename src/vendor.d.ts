/**
 * Ambient shape of the opt-in N-API OCR module. It is an optional dependency that
 * needs a native build, so it may not be installed; the import is attempted at
 * runtime and a missing build is reported as a normal backend error.
 */
declare module '@cherrystudio/mac-system-ocr' {
  export interface TextObservation {
    text: string;
    confidence: number;
    /** Normalized 0..1, bottom-left origin. */
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export interface OCRResult {
    text: string;
    confidence: number;
    observations: TextObservation[];
  }

  export interface RecognizeOptions {
    languages?: string;
    recognitionLevel?: number;
    minConfidence?: number;
  }

  const MacOCR: {
    readonly RECOGNITION_LEVEL_FAST: number;
    readonly RECOGNITION_LEVEL_ACCURATE: number;
    recognizeFromBuffer(imageBuffer: Buffer | Uint8Array, options?: RecognizeOptions): Promise<OCRResult>;
    recognizeFromPath(imagePath: string, options?: RecognizeOptions): Promise<OCRResult>;
  };

  export default MacOCR;
}
