'use client';

import { useEffect, useState } from 'react';
import { marked } from 'marked';

export default function SanitizedMarkdown({ content }: { content: string }) {
  const [safeHtml, setSafeHtml] = useState('');

  useEffect(() => {
    let cancelled = false;
    setSafeHtml('');

    // isomorphic-dompurify loads jsdom when imported on the server. Load it
    // only after hydration so the dashboard's server render doesn't depend
    // on jsdom, while still sanitizing before any generated HTML is inserted.
    import('isomorphic-dompurify').then(({ default: DOMPurify }) => {
      if (cancelled) return;
      const html = marked.parse(content) as string;
      setSafeHtml(DOMPurify.sanitize(html));
    }).catch(() => {
      // If the sanitizer chunk fails to load, keep the content as plain text.
      setSafeHtml('');
    });

    return () => { cancelled = true; };
  }, [content]);

  return safeHtml
    ? <div className="prose-chat" dangerouslySetInnerHTML={{ __html: safeHtml }} />
    : <div className="prose-chat">{content}</div>;
}
