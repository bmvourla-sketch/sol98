import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        win98: {
          // The Windows 98 palette. `teal` is the classic desktop color
          // (#008080), `silver` is the window/button face (#c0c0c0),
          // `navy` the active title-bar (#000080), and the greys drive the
          // beveled edges (light top/left, dark bottom/right).
          teal: "#008080",
          silver: "#c0c0c0",
          navy: "#000080",
          light: "#dfdfdf",
          dark: "#808080",
          darker: "#404040",
        },
      },
      fontFamily: {
        win98: ['Tahoma', '"MS Sans Serif"', '"Segoe UI"', 'sans-serif'],
        pixel: ['"Courier New"', '"Lucida Console"', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
