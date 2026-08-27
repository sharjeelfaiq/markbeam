/*
 * Monaco themes for Markbeam.
 *
 * Monaco takes concrete hex values, not CSS custom properties, so these colours are a
 * hand-kept mirror of src/styles/tokens.css. If a token changes there, change it here
 * too — otherwise the editor drifts out of the palette while everything else follows.
 */

export const DARK_THEME = 'markbeam-dark';
export const LIGHT_THEME = 'markbeam-light';

const dark = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '4DE1D0', fontStyle: 'bold' }, // headings
    { token: 'strong', foreground: 'E8EDF5', fontStyle: 'bold' },
    { token: 'emphasis', foreground: 'E8EDF5', fontStyle: 'italic' },
    { token: 'string.link', foreground: '4DE1D0' },
    { token: 'string', foreground: 'A9B4C6' },
    { token: 'variable', foreground: '7FD1C6' },
    { token: 'comment', foreground: '6B7889', fontStyle: 'italic' },
    { token: 'tag', foreground: '6B7889' }
  ],
  colors: {
    'editor.background': '#08090C',
    'editor.foreground': '#E8EDF5',
    'editorCursor.foreground': '#4DE1D0',
    'editorLineNumber.foreground': '#394354',
    'editorLineNumber.activeForeground': '#8A97AA',
    'editor.lineHighlightBackground': '#0E1015',
    'editor.selectionBackground': '#1E4A47',
    'editor.inactiveSelectionBackground': '#152F2D',
    'editorIndentGuide.background1': '#1A2130',
    'editorWhitespace.foreground': '#232B3A',
    'scrollbarSlider.background': '#232B3A80',
    'scrollbarSlider.hoverBackground': '#33405AB0',
    'scrollbarSlider.activeBackground': '#4DE1D080',
    'editorWidget.background': '#141822',
    'editorWidget.border': '#33405A'
  }
};

const light = {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '0D9488', fontStyle: 'bold' },
    { token: 'strong', foreground: '0D1219', fontStyle: 'bold' },
    { token: 'emphasis', foreground: '0D1219', fontStyle: 'italic' },
    { token: 'string.link', foreground: '0D9488' },
    { token: 'string', foreground: '47535F' },
    { token: 'variable', foreground: '0B7A70' },
    { token: 'comment', foreground: '7A8694', fontStyle: 'italic' },
    { token: 'tag', foreground: '7A8694' }
  ],
  colors: {
    'editor.background': '#F4F6F8',
    'editor.foreground': '#0D1219',
    'editorCursor.foreground': '#0D9488',
    'editorLineNumber.foreground': '#B3BECB',
    'editorLineNumber.activeForeground': '#47535F',
    'editor.lineHighlightBackground': '#EAEEF3',
    'editor.selectionBackground': '#BFE9E4',
    'editor.inactiveSelectionBackground': '#DCF0ED',
    'scrollbarSlider.background': '#C2CBD680',
    'scrollbarSlider.hoverBackground': '#A8B4C2B0',
    'scrollbarSlider.activeBackground': '#0D948880'
  }
};

export const defineThemes = (monaco) => {
  monaco.editor.defineTheme(DARK_THEME, dark);
  monaco.editor.defineTheme(LIGHT_THEME, light);
};

export const themeFor = (resolved) => (resolved === 'dark' ? DARK_THEME : LIGHT_THEME);
