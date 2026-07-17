/**
 * Visual themes for the loopback sign-in page. The structural CSS is shared;
 * a theme only swaps the design tokens below. Pick one with `--theme <name>`,
 * the `MCP_SECURE_ENV_THEME` env var, or `"theme"` in the config file.
 */
export interface ThemeTokens {
  /** Page background (any CSS background value). */
  background: string;
  surface: string;
  border: string;
  borderSubtle: string;
  text: string;
  textStrong: string;
  textMuted: string;
  textSoft: string;
  brand: string;
  brandHover: string;
  brandActive: string;
  buttonText: string;
  inputBackground: string;
  focusRing: string;
  danger: string;
  font: string;
  radius: string;
  radiusCard: string;
  shadow: string;
}

const FONT_SANS = `'Rubik', 'Segoe UI', Arial, sans-serif`;
const FONT_MONO = `ui-monospace, 'Cascadia Code', Consolas, monospace`;

export const THEMES: Record<string, ThemeTokens> = {
  light: {
    background:
      'radial-gradient(circle at top left, rgba(99,132,155,.14), transparent 34%),' +
      'linear-gradient(135deg, #f0f4f8 0%, #fafcfe 50%, #eef2f6 100%)',
    surface: '#ffffff',
    border: '#d8e2ec',
    borderSubtle: '#e6edf4',
    text: '#3a4654',
    textStrong: '#1f2d3d',
    textMuted: '#64748b',
    textSoft: '#8296ab',
    brand: '#3f6c8c',
    brandHover: '#37607d',
    brandActive: '#30556f',
    buttonText: '#ffffff',
    inputBackground: '#ffffff',
    focusRing: 'rgba(63,108,140,.18)',
    danger: '#c0526b',
    font: FONT_SANS,
    radius: '6px',
    radiusCard: '14px',
    shadow: '0 10px 24px rgba(31,45,61,.10)',
  },
  dark: {
    background: 'linear-gradient(135deg, #10151c 0%, #171e28 55%, #121820 100%)',
    surface: '#1c242f',
    border: '#2c3846',
    borderSubtle: '#26303d',
    text: '#c4cedb',
    textStrong: '#eef3f9',
    textMuted: '#8fa0b3',
    textSoft: '#69798c',
    brand: '#5b93c0',
    brandHover: '#6ba1cc',
    brandActive: '#4d84b1',
    buttonText: '#0e141b',
    inputBackground: '#141b24',
    focusRing: 'rgba(91,147,192,.28)',
    danger: '#d97788',
    font: FONT_SANS,
    radius: '6px',
    radiusCard: '14px',
    shadow: '0 12px 30px rgba(0,0,0,.45)',
  },
  ocean: {
    background:
      'radial-gradient(circle at 15% 10%, rgba(56,163,181,.20), transparent 40%),' +
      'radial-gradient(circle at 85% 90%, rgba(23,107,135,.22), transparent 40%),' +
      'linear-gradient(160deg, #e8f6f8 0%, #f2fbfc 50%, #e2f1f5 100%)',
    surface: '#ffffff',
    border: '#c8e4ea',
    borderSubtle: '#dbeef2',
    text: '#2f4f58',
    textStrong: '#123c47',
    textMuted: '#54767f',
    textSoft: '#7c9aa2',
    brand: '#177b90',
    brandHover: '#136e81',
    brandActive: '#106173',
    buttonText: '#ffffff',
    inputBackground: '#ffffff',
    focusRing: 'rgba(23,123,144,.18)',
    danger: '#c0526b',
    font: FONT_SANS,
    radius: '8px',
    radiusCard: '18px',
    shadow: '0 12px 28px rgba(18,60,71,.14)',
  },
  forest: {
    background:
      'radial-gradient(circle at 80% 15%, rgba(90,145,90,.16), transparent 42%),' +
      'linear-gradient(150deg, #eef4ec 0%, #f7faf5 55%, #e9f1e7 100%)',
    surface: '#ffffff',
    border: '#d3e2d0',
    borderSubtle: '#e2ecdf',
    text: '#3c4a3c',
    textStrong: '#22301f',
    textMuted: '#65775f',
    textSoft: '#8b9a84',
    brand: '#4a7c46',
    brandHover: '#416f3e',
    brandActive: '#3a6337',
    buttonText: '#ffffff',
    inputBackground: '#ffffff',
    focusRing: 'rgba(74,124,70,.18)',
    danger: '#bc5b52',
    font: FONT_SANS,
    radius: '6px',
    radiusCard: '14px',
    shadow: '0 10px 24px rgba(34,48,31,.12)',
  },
  terminal: {
    background: '#0b0f0c',
    surface: '#101610',
    border: '#1f3322',
    borderSubtle: '#182a1b',
    text: '#9fd9a6',
    textStrong: '#c9f7ce',
    textMuted: '#6faa77',
    textSoft: '#4c7a54',
    brand: '#38c05a',
    brandHover: '#45cd67',
    brandActive: '#2da84c',
    buttonText: '#06130a',
    inputBackground: '#0c120d',
    focusRing: 'rgba(56,192,90,.30)',
    danger: '#e06c60',
    font: FONT_MONO,
    radius: '2px',
    radiusCard: '6px',
    shadow: '0 0 0 1px rgba(56,192,90,.12), 0 14px 34px rgba(0,0,0,.6)',
  },
  sunset: {
    background:
      'radial-gradient(circle at 20% 20%, rgba(244,151,110,.22), transparent 45%),' +
      'radial-gradient(circle at 85% 80%, rgba(180,84,130,.18), transparent 45%),' +
      'linear-gradient(150deg, #fdf1e8 0%, #fdf7f0 50%, #f9ebe6 100%)',
    surface: '#fffdfb',
    border: '#f0d9c8',
    borderSubtle: '#f6e6d9',
    text: '#5c4438',
    textStrong: '#3d2a21',
    textMuted: '#8a6f60',
    textSoft: '#ab9284',
    brand: '#d26a3f',
    brandHover: '#c25f37',
    brandActive: '#b05430',
    buttonText: '#ffffff',
    inputBackground: '#ffffff',
    focusRing: 'rgba(210,106,63,.20)',
    danger: '#bd4f62',
    font: FONT_SANS,
    radius: '8px',
    radiusCard: '18px',
    shadow: '0 12px 28px rgba(61,42,33,.14)',
  },
};

export const DEFAULT_THEME = 'light';

export function themeNames(): string[] {
  return Object.keys(THEMES);
}

export function resolveTheme(name: string | undefined): ThemeTokens {
  const requested = name ?? DEFAULT_THEME;
  const theme = THEMES[requested.toLowerCase()];
  if (theme === undefined) {
    throw new Error(`Unknown theme '${requested}'. Available themes: ${themeNames().join(', ')}`);
  }

  return theme;
}

/** The full stylesheet for the sign-in page under the given theme. */
export function renderStyle(theme: ThemeTokens): string {
  return (
    `:root{--brand:${theme.brand};--brand-hover:${theme.brandHover};--brand-active:${theme.brandActive};` +
    `--button-text:${theme.buttonText};--surface:${theme.surface};--input-bg:${theme.inputBackground};` +
    `--border:${theme.border};--border-subtle:${theme.borderSubtle};--text:${theme.text};` +
    `--text-strong:${theme.textStrong};--text-muted:${theme.textMuted};--text-soft:${theme.textSoft};` +
    `--danger:${theme.danger};--focus-ring:${theme.focusRing};--radius:${theme.radius};` +
    `--radius-card:${theme.radiusCard};--shadow:${theme.shadow};--font:${theme.font}}` +
    `*{box-sizing:border-box}` +
    `body{margin:0;min-height:100vh;font-family:var(--font);font-size:15px;color:var(--text);` +
    `display:flex;align-items:center;justify-content:center;padding:2rem 1rem;` +
    `background:${theme.background}}` +
    `.card{width:100%;max-width:26rem;background:var(--surface);border:1px solid var(--border);` +
    `border-radius:var(--radius-card);box-shadow:var(--shadow);overflow:hidden}` +
    `.card-head{display:flex;align-items:center;gap:.6rem;padding:.85rem 1.25rem;` +
    `border-bottom:1px solid var(--border-subtle);color:var(--text-muted);` +
    `font-weight:700;font-size:12px;letter-spacing:.04em;text-transform:uppercase}` +
    `.card-body{padding:1.5rem 1.25rem}` +
    `h1{margin:.1rem 0 .5rem;font-size:21px;font-weight:600;color:var(--text-strong)}` +
    `.muted{color:var(--text-muted);font-size:.92rem;margin:.25rem 0 1rem;line-height:1.5}` +
    `label{display:block;font-weight:700;font-size:12px;color:var(--text);margin:.9rem 0 .3rem}` +
    `.hint{display:block;color:var(--text-soft);font-size:.8rem;font-weight:400;margin:.15rem 0 0}` +
    `input{width:100%;padding:.5rem .75rem;font-size:1rem;font-family:var(--font);color:var(--text-strong);` +
    `background:var(--input-bg);border:1px solid var(--border-subtle);border-radius:var(--radius)}` +
    `input:focus{outline:0;border-color:var(--brand);box-shadow:0 0 0 .25rem var(--focus-ring)}` +
    `button{width:100%;margin-top:1.5rem;padding:.7rem 1.5rem;font-size:1rem;font-weight:600;` +
    `font-family:var(--font);color:var(--button-text);background:var(--brand);` +
    `border:1px solid var(--brand);border-radius:60px;cursor:pointer}` +
    `button:hover{background:var(--brand-hover);border-color:var(--brand-hover)}` +
    `button:active{background:var(--brand-active);border-color:var(--brand-active)}` +
    `.error{color:var(--danger);font-size:.9rem;margin:.75rem 0 0}` +
    `.footnote{margin:1.1rem 0 0;color:var(--text-soft);font-size:.82rem;line-height:1.45}`
  );
}
