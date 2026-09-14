import { PDFParse } from "pdf-parse";

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  hasText: boolean;
}

export class PdfExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "PdfExtractionError";
    if (options?.cause) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

/**
 * Extracts text from a digital PDF.
 *
 * This function is intentionally server-side only. Do not import it from a
 * Client Component because pdf-parse depends on Node/server capabilities.
 */
export async function extractPdfText(
  input: Buffer | Uint8Array,
): Promise<PdfExtractionResult> {
  if (!input || input.byteLength === 0) {
    throw new PdfExtractionError("El archivo PDF está vacío.");
  }

  const data = input instanceof Buffer ? input : Buffer.from(input);
  const parser = new PDFParse({ data });

  try {
    const [textResult, infoResult] = await Promise.all([
      parser.getText(),
      parser.getInfo({ parsePageInfo: true }),
    ]);

    const text = normalizeExtractedText(textResult.text ?? "");
    const pageCount = infoResult.total ?? 0;

    if (!text) {
      throw new PdfExtractionError(
        "No se encontró texto extraíble en el PDF. El archivo podría estar escaneado o protegido.",
      );
    }

    return {
      text,
      pageCount,
      hasText: true,
    };
  } catch (error) {
    if (error instanceof PdfExtractionError) {
      throw error;
    }

    throw new PdfExtractionError("No fue posible extraer el texto del PDF.", {
      cause: error,
    });
  } finally {
    await parser.destroy();
  }
}

/**
 * Convenience helper for tests and scripts that receive a file path.
 */
export async function extractPdfTextFromFile(filePath: string): Promise<PdfExtractionResult> {
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(filePath);
  return extractPdfText(buffer);
}
