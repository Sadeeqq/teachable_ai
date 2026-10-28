import mammoth from 'mammoth';
import { extractTextFromPdf, type PageText } from '@/lib/rag/chunk';

export const SUPPORTED_SOURCE_TYPES = [
  '.pdf', '.docx', '.txt', '.md', '.csv', '.jpg', '.jpeg', '.png', '.webp',
] as const;

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

export function getSourceExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

export function getSourceMimeType(extension: string): string {
  switch (extension) {
    case '.pdf': return 'application/pdf';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.txt': return 'text/plain';
    case '.md': return 'text/markdown';
    case '.csv': return 'text/csv';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    default: return 'application/octet-stream';
  }
}

function hasValidSignature(extension: string, buffer: Buffer): boolean {
  if (extension === '.pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (extension === '.docx') return buffer.subarray(0, 2).toString('ascii') === 'PK';
  if (extension === '.png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === '.jpg' || extension === '.jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (extension === '.webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return TEXT_EXTENSIONS.has(extension);
}

export function validateSourceFile(extension: string, buffer: Buffer): string | null {
  if (!SUPPORTED_SOURCE_TYPES.includes(extension as (typeof SUPPORTED_SOURCE_TYPES)[number])) {
    return 'Unsupported file type. Upload PDF, DOCX, TXT, Markdown, CSV, JPG, PNG, or WebP.';
  }
  if (!hasValidSignature(extension, buffer)) {
    return `The file content does not match its .${extension.slice(1)} extension.`;
  }
  return null;
}

async function extractImageText(buffer: Buffer): Promise<PageText[]> {
  // OCR is loaded only for images. Tesseract fetches its English language data
  // on first use and keeps it in its cache for subsequent requests.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createWorker } = require('tesseract.js') as typeof import('tesseract.js');
  const worker = await createWorker('eng');
  try {
    const result = await worker.recognize(buffer);
    const text = result.data.text.trim();
    if (!text) throw new Error('No readable text found in this image. Try a clearer image with legible text.');
    return [{ page: null, text }];
  } finally {
    await worker.terminate();
  }
}

export async function extractTextFromSource(buffer: Buffer, extension: string): Promise<PageText[]> {
  if (extension === '.pdf') return extractTextFromPdf(buffer);

  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();
    if (!text) throw new Error('No readable text found in this DOCX file.');
    return [{ page: null, text }];
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).trim();
    if (!text) throw new Error('This file contains no readable text.');
    return [{ page: null, text }];
  }

  if (IMAGE_EXTENSIONS.has(extension)) return extractImageText(buffer);
  throw new Error('Unsupported file type.');
}
