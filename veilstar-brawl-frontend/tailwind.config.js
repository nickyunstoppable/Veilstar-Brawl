/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        orbitron: ['"Orbitron"', 'sans-serif'],
        montserrat: ['"Montserrat"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', '"Fira Code"', '"JetBrains Mono"', 'Consolas', 'monospace'],
      },
      colors: {
        'cyber-black': '#010101',
        'cyber-gold': '#F0B71F',
        'cyber-orange': '#E03609',
        'cyber-blue': '#00F0FF',
        'cyber-gray': '#DDD',
      },
      backgroundImage: {
        'gradient-cyber': 'linear-gradient(90deg, #F0B71F 0%, #E03609 100%)',
        'gradient-cyber-270': 'linear-gradient(270deg, #F0B71F 0%, #E03609 100%)',
      },
      screens: {
        'xs': '480px',
      },
    },
  },
  plugins: [],
};
