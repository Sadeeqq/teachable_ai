// ═══════════════════════════════════════════════════════════════════════════
// chunk.ts — source text extraction + overlapping chunking.
// Direct port of the old pdf_processor.py logic to TypeScript.
// ═══════════════════════════════════════════════════════════════════════════

// ⚠️ Import the internal lib file directly, NOT 'pdf-parse' itself.
// pdf-parse's package index.js has a debug code path that runs at import
// time and tries to read a bundled test PDF from disk — this throws
// ENOENT in serverless/webpack environments (a well-known issue with this
// package under Next.js). Importing the internal module skips that entirely.
// @ts-ignore — pdf-parse has no bundled types
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const CHUNK_SIZE = 500;      // target tokens per chunk
const CHUNK_OVERLAP = 50;    // overlap tokens between chunks
const CHARS_PER_TOKEN = 4;   // rough approximation

export interface PageText { page: number | null; text: string; }
export interface Chunk { chunkIndex: number; page: number | null; section: string | null; text: string; }

function cleanLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isSectionHeading(line: string): boolean {
  if (line.length < 3 || line.length > 100 || /[.!?]$/.test(line)) return false;
  if (/^(chapter|unit|part|section|module|lesson|topic|appendix)\s+([\d.]+|[a-z])/i.test(line)) return true;
  if (/^\d+(?:\.\d+)*[.)]?\s+\S/.test(line)) return true;
  const letters = line.replace(/[^a-z]/gi, '');
  return letters.length >= 4 && letters === letters.toUpperCase();
}

// pdf-parse gives whole-document text, not per-page, by default. We use its
// `pagerender` hook to capture per-page text so citations keep page numbers.
export async function extractTextFromPdf(fileBuffer: Buffer): Promise<PageText[]> {
  const pages: PageText[] = [];

  await pdfParse(fileBuffer, {
    pagerender: async (pageData: any) => {
      const textContent = await pageData.getTextContent();
      // Keep PDF.js line endings so heading detection can distinguish a
      // short heading from a phrase that happens to occur in body text.
      let line = '';
      const lines: string[] = [];
      for (const item of textContent.items as any[]) {
        line += `${item.str ?? ''} `;
        if (item.hasEOL) {
          const cleaned = cleanLine(line);
          if (cleaned) lines.push(cleaned);
          line = '';
        }
      }
      const finalLine = cleanLine(line);
      if (finalLine) lines.push(finalLine);
      const text = lines.join('\n');
      if (text) pages.push({ page: pageData.pageNumber, text });
      return text;
    },
  });

  if (!pages.length) {
    throw new Error('No readable text found in this PDF. It may be scanned or image-based.');
  }
  return pages;
}

export function chunkPages(pages: PageText[]): Chunk[] {
  const chunkChars = CHUNK_SIZE * CHARS_PER_TOKEN;
  const overlapChars = CHUNK_OVERLAP * CHARS_PER_TOKEN;
  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  let activeSection: string | null = null;

  for (const { page, text } of pages) {
    const headings: { offset: number; title: string }[] = [];
    let lineOffset = 0;
    for (const line of text.split('\n')) {
      if (isSectionHeading(line)) headings.push({ offset: lineOffset, title: line });
      lineOffset += line.length + 1;
    }
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + chunkChars, text.length);
      const chunkText = text.slice(start, end).trim();
      const precedingHeadings = headings.filter((h) => h.offset <= start);
      const section = precedingHeadings[precedingHeadings.length - 1]?.title ?? activeSection;

      if (chunkText.length > 50) {
        chunks.push({ chunkIndex, page, section, text: chunkText });
        chunkIndex += 1;
      }

      if (end === text.length) break;
      start = end - overlapChars;
    }
    if (headings.length) activeSection = headings[headings.length - 1].title;
  }
  return chunks;
}
