// Inline-SVG icon set — stroke-based, 1.8 weight, 24×24 grid.
// We use these instead of an icon font for reliability.

function Icon({ name, size = 18 }) {
  const p = ICONS[name];
  if (!p) return null;
  return (
    <svg xmlns="http://www.w3.org/2000/svg"
         width={size} height={size} viewBox="0 0 24 24"
         fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round"
         style={{flexShrink:0}}
         dangerouslySetInnerHTML={{__html: p}}/>
  );
}

const ICONS = {
  // Navigation
  dashboard: `<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>`,
  eco: `<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 22c1.7-2.5 4.6-7 8-10"/>`,
  map: `<path d="M9 4 3 6v15l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v15"/><path d="M15 6v15"/>`,
  compare_arrows: `<path d="m8 3-4 4 4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>`,
  fact_check: `<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 10 1.5 1.5L13 9"/><path d="M16 11h2"/><path d="m9 16 1.5 1.5L13 15"/><path d="M16 17h2"/>`,
  database: `<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>`,
  hub: `<circle cx="12" cy="12" r="2.4"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M10.3 10.6 6.3 7.2"/><path d="m13.7 10.6 4-3.4"/><path d="m10.3 13.4-4 3.4"/><path d="m13.7 13.4 4 3.4"/>`,
  download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`,
  api: `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>`,
  help: `<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  info: `<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>`,
  notifications: `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
  schedule: `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
  arrow_upward: `<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>`,
  arrow_downward: `<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>`,
  search: `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`,
  person: `<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
  filter: `<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>`,
  menu_book: `<path d="M2 19V5a2 2 0 0 1 2-2h6v18H4a2 2 0 0 1-2-2z"/><path d="M22 19V5a2 2 0 0 0-2-2h-6v18h6a2 2 0 0 0 2-2z"/>`,
  refresh: `<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>`,
  format_quote: `<path d="M7 7h4v6H5v-2c0-2 .5-3 2-4zm8 0h4v6h-6v-2c0-2 .5-3 2-4z"/>`,
  link: `<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>`,
  more_vert: `<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>`,
  content_copy: `<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`,
  close: `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
  expand_more: `<polyline points="6 9 12 15 18 9"/>`,
  warning: `<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  pulse: `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
  table_chart: `<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>`,
  trending_up: `<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>`,
  factory: `<path d="M3 21V9l6 4V9l6 4V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v16z"/><path d="M3 21h18"/><line x1="7" y1="17" x2="7.01" y2="17"/><line x1="11" y1="17" x2="11.01" y2="17"/><line x1="15" y1="17" x2="15.01" y2="17"/>`,
  // Feedback channel + catalog
  feedback: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/>`,
  bug_report: `<line x1="9" y1="5" x2="7.5" y2="3.5"/><line x1="15" y1="5" x2="16.5" y2="3.5"/><rect x="8" y="6" width="8" height="13" rx="4"/><line x1="12" y1="7" x2="12" y2="19"/><line x1="8" y1="10" x2="5" y2="9"/><line x1="8" y1="13" x2="4.5" y2="13"/><line x1="8" y1="16" x2="5" y2="17.5"/><line x1="16" y1="10" x2="19" y2="9"/><line x1="16" y1="13" x2="19.5" y2="13"/><line x1="16" y1="16" x2="19" y2="17.5"/>`,
  lightbulb: `<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.4 1 1.1 1 1.8v.5h6v-.5c0-.7.4-1.4 1-1.8A7 7 0 0 0 12 2z"/>`,
  check_circle: `<circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/>`,
  inventory_2: `<rect x="3" y="8" width="18" height="12" rx="1.5"/><path d="M3 8l1.8-3.2A1 1 0 0 1 5.7 4h12.6a1 1 0 0 1 .9.8L21 8"/><line x1="10" y1="12" x2="14" y2="12"/>`,
  // storefront (loja/mercado) — the "Tipo de Mercado" editor: a market stall with an awning.
  storefront: `<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2 2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/>`,
};

window.Icon = Icon;
