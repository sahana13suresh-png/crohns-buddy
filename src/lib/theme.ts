/**
 * Crohn's Buddy Blue Color Palette
 *
 * A consistent blue theme used across the entire application.
 * These constants are referenced by both Tailwind config and component styles.
 */

export const colors = {
  blue: {
    50: '#eff6ff',
    100: '#dbeafe',
    200: '#bfdbfe',
    300: '#93c5fd',
    400: '#60a5fa',
    500: '#3b82f6',
    600: '#2563eb',
    700: '#1d4ed8',
    800: '#1e40af',
    900: '#1e3a8a',
    950: '#172554',
  },
} as const;

/** Primary brand color used for headings, buttons, and active elements */
export const primary = colors.blue[600];

/** Light background tint for cards and hero sections */
export const primaryLight = colors.blue[50];

/** Darker shade for hover states and emphasis */
export const primaryDark = colors.blue[800];

/** Link color */
export const linkColor = colors.blue[600];

/** Active tab / accent color */
export const accent = colors.blue[500];

/** Header background */
export const headerBg = colors.blue[700];

/** Navigation active tab background */
export const navActiveBg = colors.blue[600];

/** Navigation inactive tab text */
export const navInactiveText = colors.blue[200];
