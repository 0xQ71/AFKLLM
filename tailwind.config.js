/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // RGB channels (see --afk-*-rgb in index.css) so /opacity modifiers work on all themes
        ink: {
          950: 'rgb(var(--afk-bg-rgb) / <alpha-value>)',
          900: 'rgb(var(--afk-bg-elevated-rgb) / <alpha-value>)',
          800: 'rgb(var(--afk-bg-hover-rgb) / <alpha-value>)',
          bright: 'rgb(var(--afk-bright-rgb) / <alpha-value>)',
          soft: 'rgb(var(--afk-soft-rgb) / <alpha-value>)',
          mute: 'rgb(var(--afk-mute-rgb) / <alpha-value>)',
          line: 'rgb(var(--afk-line-rgb) / <alpha-value>)'
        },
        signal: {
          DEFAULT: 'rgb(var(--afk-signal-rgb) / <alpha-value>)',
          dim: 'rgb(var(--afk-signal-dim-rgb) / <alpha-value>)',
          on: 'rgb(var(--afk-on-signal-rgb) / <alpha-value>)'
        },
        danger: {
          DEFAULT: 'rgb(var(--afk-danger-rgb) / <alpha-value>)',
          muted: 'var(--afk-danger-muted)'
        },
        warn: {
          DEFAULT: 'rgb(var(--afk-warn-rgb) / <alpha-value>)',
          muted: 'var(--afk-warn-muted)'
        }
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'Segoe UI', 'sans-serif'],
        display: ['"IBM Plex Sans"', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'Consolas', 'monospace']
      }
    }
  },
  plugins: []
}
