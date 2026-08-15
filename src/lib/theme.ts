/**
 * Crohn's Buddy — Strict 3-Color Palette
 *
 * Background: light blue (#e8f4fc)
 * Text: dark navy (#0f2240)
 * Accent: mid blue (#5eb0e6)
 */

export const colors = {
  blue: {
    50: '#dff2ff',   // Background — matches logo background
    100: '#d0e4f7',
    200: '#b4dcf5',
    300: '#89c8ef',
    400: '#5eb0e6',  // Accent
    500: '#4a9dd4',
    600: '#1b3a5c',
    700: '#152d4a',
    800: '#0f2240',  // Text
    900: '#0a1a33',
    950: '#061122',
  },
} as const;

export const primary = colors.blue[800];
export const primaryLight = colors.blue[50];
export const primaryDark = colors.blue[800];
export const linkColor = colors.blue[400];
export const accent = colors.blue[400];
export const headerBg = colors.blue[50];
export const navActiveBg = colors.blue[800];
export const navInactiveText = colors.blue[600];
