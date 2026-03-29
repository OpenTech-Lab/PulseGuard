/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    screens: {
      sm: "480px",
      md: "580px",
      lg: "680px",
      xl: "900px",
      "2xl": "1200px",
    },
    extend: {
      animation: {
        "pulse-enter": "pulse-enter 420ms ease-out",
      },
      boxShadow: {
        ambient:
          "0 18px 42px rgba(17, 24, 39, 0.12), 0 6px 18px rgba(17, 24, 39, 0.08)",
      },
      colors: {
        accent: {
          50: "#effbf5",
          100: "#d7f5e3",
          200: "#b2e9cc",
          300: "#7fd8ad",
          400: "#45c084",
          500: "#1ea768",
          600: "#158553",
          700: "#166845",
          800: "#175238",
          900: "#16452f"
        }
      },
      keyframes: {
        "pulse-enter": {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
};

