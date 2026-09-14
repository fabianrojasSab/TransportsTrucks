import { MANIFEST_SECTION_ALIASES } from "../manifiestos_archivos/manifest-field-aliases";
import type { ManifestSection } from "../manifiestos_archivos/manifest-extraction";

export interface ParsedLine {
  index: number;
  raw: string;
  normalized: string;
}

export interface ParsedSection {
  section: ManifestSection;
  startLine: number;
  endLine: number;
  lines: ParsedLine[];
  rawText: string;
}

export interface ParsedSections {
  lines: ParsedLine[];
  sections: ParsedSection[];
}

/**
 * Normalization used for comparisons. Spaces are preserved because the PDF
 * extractor must keep the horizontal layout of table columns.
 */
export function normalizePdfText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[‐‑‒–—−]/g, "-")
    .toUpperCase();
}

export function normalizeLine(value: string): string {
  return normalizePdfText(value).replace(/\s+$/g, "").trim();
}

export function sameText(value: string, expected: string): boolean {
  return normalizeLine(value) === normalizeLine(expected);
}

export function containsAlias(line: string, aliases: readonly string[]): string | null {
  const normalized = normalizePdfText(line);

  const ordered = [...aliases].sort(
    (a, b) => normalizePdfText(b).length - normalizePdfText(a).length,
  );

  for (const alias of ordered) {
    if (normalized.includes(normalizePdfText(alias))) {
      return alias;
    }
  }

  return null;
}

/**
 * A section title must match the complete normalized line. Field labels such
 * as "MANIFIESTO" therefore do not become false sections.
 */
export function detectSectionFromLine(line: string): ManifestSection | null {
  const normalized = normalizeLine(line);

  const sections = Object.keys(MANIFEST_SECTION_ALIASES) as ManifestSection[];

  for (const section of sections) {
    if (
      MANIFEST_SECTION_ALIASES[section].some(
        (alias) => normalizeLine(alias) === normalized,
      )
    ) {
      return section;
    }
  }

  return null;
}

export function parseSections(text: string): ParsedSections {
  const rawLines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  const lines: ParsedLine[] = rawLines
    .map((raw, index) => ({
      index,
      raw,
      normalized: normalizeLine(raw),
    }))
    .filter((line) => line.normalized.length > 0);

  const starts: Array<{ section: ManifestSection; line: ParsedLine }> = [];

  for (const line of lines) {
    const section = detectSectionFromLine(line.raw);
    if (section) starts.push({ section, line });
  }

  const sections = starts.map((current, index) => {
    const next = starts[index + 1];
    const startIndex = lines.findIndex((line) => line.index === current.line.index);
    const nextIndex = next
      ? lines.findIndex((line) => line.index === next.line.index)
      : lines.length;

    const sectionLines = lines.slice(startIndex, nextIndex);

    return {
      section: current.section,
      startLine: current.line.index,
      endLine: next ? next.line.index - 1 : current.line.index + sectionLines.length,
      lines: sectionLines,
      rawText: sectionLines.map((line) => line.raw).join("\n"),
    } satisfies ParsedSection;
  });

  return { lines, sections };
}

export function getSection(
  parsed: ParsedSections,
  section: ManifestSection,
): ParsedSection | undefined {
  return parsed.sections.find((item) => item.section === section);
}

/**
 * Splits a layout-preserving PDF line. Two or more spaces are column
 * separators; a single space is part of the value.
 */
export function splitLayoutColumns(line: string): string[] {
  return line
    .trim()
    .split(/\s{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function findLine(
  lines: ParsedLine[],
  predicate: (line: ParsedLine) => boolean,
): ParsedLine | undefined {
  return lines.find(predicate);
}

export function findLineIndex(
  lines: ParsedLine[],
  predicate: (line: ParsedLine) => boolean,
): number {
  return lines.findIndex(predicate);
}

/**
 * Returns the first non-empty line after a given source line.
 */
export function nextLine(
  lines: ParsedLine[],
  sourceIndex: number,
  offset = 1,
): ParsedLine | undefined {
  return lines[sourceIndex + offset];
}

/**
 * Search a line for a label while preserving enough information to recover
 * the original text around that label.
 */
export function locateAlias(
  line: string,
  aliases: readonly string[],
): { alias: string; start: number; end: number } | null {
  const normalizedLine = normalizePdfText(line);

  const ordered = [...aliases].sort(
    (a, b) => normalizePdfText(b).length - normalizePdfText(a).length,
  );

  for (const alias of ordered) {
    const normalizedAlias = normalizePdfText(alias);
    const start = normalizedLine.indexOf(normalizedAlias);
    if (start >= 0) {
      return {
        alias,
        start,
        end: start + normalizedAlias.length,
      };
    }
  }

  return null;
}
