import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Teachable — AI Study Tutor',
  description: 'Your personal AI tutor, grounded in your own course material.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" />
      </head>
      <body className="font-sans antialiased" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
        {children}
      </body>
    </html>
  );
}
