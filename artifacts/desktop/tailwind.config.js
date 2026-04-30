/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        forest: {
          50:  '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          300: '#86efac',
          400: '#4ade80',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
          900: '#14532d',
          950: '#052e16',
        },
        glass: {
          bg:    'rgba(6, 14, 9, 0.95)',
          panel: 'rgba(10, 22, 13, 0.85)',
          card:  'rgba(15, 30, 18, 0.7)',
          hover: 'rgba(22, 163, 74, 0.08)',
          border:'rgba(255, 255, 255, 0.07)',
        },
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
      backdropBlur: {
        glass: '40px',
      },
    },
  },
  plugins: [],
};
