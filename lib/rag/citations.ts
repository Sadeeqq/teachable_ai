export function formatDocumentCitation(citation: {
  filename?: string | null;
  page?: number | null;
}): string {
  const filename = citation.filename?.trim();
  if (!filename || filename.toLowerCase() === 'unknown') {
    return 'Document source unavailable';
  }

  const page = citation.page;
  return typeof page === 'number' && Number.isInteger(page) && page > 0
    ? `From “${filename}” on PDF page ${page}.`
    : `From “${filename}”.`;
}
