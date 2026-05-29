/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/web/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          base: '#0b1120',
          panel: '#0f172a',
          line: '#1e293b',
        },
        ink: {
          base: '#e2e8f0',
          subtle: '#94a3b8',
          muted: '#64748b',
        },
        accent: {
          cyan: '#22d3ee',
          green: '#22c55e',
          amber: '#f59e0b',
          red: '#f87171',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
