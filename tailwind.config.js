/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Outfit', 'sans-serif'] },
      colors: {
        brand: { 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7' },
        darkblue: '#1e3a8a',
      },
    },
  },
  plugins: [],
};
