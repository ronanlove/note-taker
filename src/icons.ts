const paths = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  eraser:
    '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21"/><path d="M22 21H7M5 11l9 9"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  folder:
    '<path d="M12 10v6M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  // Writing tools are drawn upright, then tilted like a held pen.
  fountain: '<g transform="rotate(45 12 12)"><path d="M9 3h6l2.5 7.5L12 21l-5.5-10.5Z"/><circle cx="12" cy="11" r="1.4"/><path d="M12 12.5V21"/></g>',
  ballpoint: '<g transform="rotate(45 12 12)"><path d="M9.5 2h5v12L12 19l-2.5-5Z"/><path d="M9.5 14h5M12 19v2.5"/></g>',
  highlighter: '<g transform="rotate(45 12 12)"><path d="M8.5 2h7v10l-1 3h-5l-1-3Z"/><path d="M8.5 12h7M9.5 15v4.5l5-2V15"/></g>',
  lasso:
    '<path d="M7.5 17.2C4.3 16 2 13.7 2 11c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8c-.9 0-1.8-.1-2.6-.3"/><circle cx="7" cy="18" r="1.8"/><path d="M7 19.8c0 1.2-.6 1.9-1.6 2.2"/>',
  trash: '<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M12 18v-6M9 15l3-3 3 3"/>',
};

export type IconName = keyof typeof paths;

export const icon = (name: IconName) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
