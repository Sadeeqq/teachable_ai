'use client';

import { useEffect, useState } from 'react';

const THEMES = ['light', 'dark', 'cafe', 'neon', 'aqua'] as const;
const LABELS: Record<(typeof THEMES)[number], string> = {
  light: '☀️ Light', dark: '🌙 Dark',
  cafe: '☕ Cafe Brown', neon: '💜 Neon Purple', aqua: '🌊 Aqua Marine',
};
const KEY = 'teachable_theme';

export default function ThemeSelect() {
  const [theme, setTheme] = useState<string>('light');

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    const initial = THEMES.includes(saved as any) ? saved! : 'light';
    setTheme(initial);
    document.documentElement.setAttribute('data-theme', initial);
  }, []);

  function apply(t: string) {
    setTheme(t);
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(KEY, t);
  }

  return (
    <select
      id="themeSelect"
      aria-label="Select theme"
      value={theme}
      onChange={(e) => apply(e.target.value)}
    >
      {THEMES.map((t) => (
        <option key={t} value={t}>{LABELS[t]}</option>
      ))}
    </select>
  );
}
