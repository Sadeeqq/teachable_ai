/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === 'production';

// script-src needs 'unsafe-inline' for Next.js's own hydration data scripts,
// and 'unsafe-eval' in dev only (webpack fast-refresh). A stricter,
// nonce-based CSP is possible but requires threading a per-request nonce
// through middleware into every script tag — a bigger lift than this pass
// covers; flagging it here as a legitimate next step rather than silently
// overclaiming what this CSP actually locks down.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",
  "img-src 'self' data: blob: https://*.supabase.co",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.groq.com https://api.openai.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: '25mb' },
    // onnxruntime-node (used by @xenova/transformers for local embeddings) is
    // a native binary package — webpack must NOT try to bundle it, or it
    // breaks with MODULE_NOT_FOUND at runtime. This tells Next.js to load it
    // directly from node_modules instead.
    serverComponentsExternalPackages: ['@xenova/transformers', 'onnxruntime-node', 'tesseract.js'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          // frame-ancestors above is the modern CSP equivalent; X-Frame-Options
          // kept too for older browsers that don't read CSP frame-ancestors.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }] : []),
        ],
      },
    ];
  },
};

module.exports = nextConfig;
