import { createHash } from "node:crypto";

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

// Must stay byte-identical to the inline theme script in ui/setup/index.html; a test enforces this.
export const THEME_SCRIPT = `
  (() => {
    const param = new URLSearchParams(window.location.search).get("scoutTheme");
    const theme =
      param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  })();
`;

export const scriptHash = (source) => `'sha256-${createHash("sha256").update(source).digest("base64")}'`;

// Static pages never run application script; the only script is the hashed theme detector.
export function pageCsp({ forms = false } = {}) {
  return [
    "default-src 'none'", `script-src ${scriptHash(THEME_SCRIPT)}`, "style-src 'unsafe-inline'",
    `form-action ${forms ? "https://github.com" : "'none'"}`, "base-uri 'none'", "frame-ancestors 'none'",
  ].join("; ");
}

// The SPA shell may run its own bundle and any bare inline script it ships, each pinned by hash.
export function shellCsp(html) {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => scriptHash(match[1]));
  return [
    "default-src 'none'", ["script-src 'self'", ...inline].join(" "), "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "form-action 'self' https://github.com",
    "base-uri 'none'", "frame-ancestors 'none'",
  ].join("; ");
}

const PAGE_STYLE = `
:root {
  color-scheme: light;
  --cp-bg: #f7f4ef;
  --cp-bg-elevated: #fcfbf8;
  --cp-surface: #ffffff;
  --cp-surface-soft: #f5f5f5;
  --cp-border: #dedede;
  --cp-border-strong: #919191;
  --cp-text: #242424;
  --cp-text-muted: #5c5c5c;
  --cp-text-soft: #6f6f6f;
  --cp-accent: #b11f4b;
  --cp-accent-hover: #9a1a41;
  --cp-accent-soft: rgba(177, 31, 75, 0.08);
  --cp-accent-fg: #ffffff;
  --cp-success: #16a34a;
  --cp-danger: #dc2626;
  --cp-warning: #f59e0b;
  --cp-link: #0078d4;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
  --cp-overlay: rgba(255, 255, 255, 0.8);
  --cp-panel: rgba(255, 255, 255, 0.86);
  --cp-panel-strong: rgba(255, 255, 255, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.55);
  --cp-highlight: rgba(177, 31, 75, 0.12);
}
html[data-theme="dark"] {
  color-scheme: dark;
  --cp-bg: #3d3b3a;
  --cp-bg-elevated: #343231;
  --cp-surface: #292929;
  --cp-surface-soft: #2e2e2e;
  --cp-border: #474747;
  --cp-border-strong: #5f5f5f;
  --cp-text: #dedede;
  --cp-text-muted: #919191;
  --cp-text-soft: #b0b0b0;
  --cp-accent: #fd8ea1;
  --cp-accent-hover: #fb7b91;
  --cp-accent-soft: rgba(253, 142, 161, 0.14);
  --cp-accent-fg: #1a1a1a;
  --cp-success: #4ade80;
  --cp-danger: #f87171;
  --cp-warning: #fbbf24;
  --cp-link: #4da6ff;
  --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  --cp-overlay: rgba(41, 41, 41, 0.88);
  --cp-panel: rgba(41, 41, 41, 0.72);
  --cp-panel-strong: rgba(41, 41, 41, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.04);
  --cp-highlight: rgba(253, 142, 161, 0.12);
}
body { background: var(--cp-bg); color: var(--cp-text); font: 16px/1.6 "Segoe UI", Aptos, Calibri, -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; }
main { max-width: 640px; margin: 48px auto; padding: 0 24px; }
h1 { line-height: 1.2; margin-bottom: 8px; }
.card { background: var(--cp-surface); border: 1px solid var(--cp-border); border-radius: 16px; box-shadow: 0 0 2px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.14); margin: 24px 0; padding: 24px; }
.muted { color: var(--cp-text-muted); }
a { color: var(--cp-link); }
code { font-family: Consolas, "Courier New", Courier, monospace; }
ul { padding-left: 20px; }
button { font: inherit; background: var(--cp-accent); color: var(--cp-accent-fg); border: 0; border-radius: 0.625rem; padding: 12px 20px; cursor: pointer; }
button:hover { background: var(--cp-accent-hover); }
:focus-visible { outline: 3px solid var(--cp-accent); outline-offset: 4px; }
`;

export function renderPage({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script>${THEME_SCRIPT}</script>
<style>${PAGE_STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}
