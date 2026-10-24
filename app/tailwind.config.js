/** Design tokens mirror the team doc's "Design language" section. */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        sky: { 0: "#F7F9FC", 1: "#EAF1FB" },
        ink: { DEFAULT: "#0B1B33", 2: "#4A5B73", 3: "#7A8AA0" },
        runway: { DEFAULT: "#2563EB", soft: "rgba(37,99,235,0.10)" },
        ok: "#16A34A",
        watch: "#D97706",
        alert: "#DC2626",
        tfr: "#C026D3",
        hairline: "rgba(15,30,60,0.08)",
      },
      fontFamily: {
        sans: ['"Geist Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"Geist Mono Variable"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: { panel: "20px", control: "12px" },
      boxShadow: {
        glass: "inset 1px 1px 0 rgba(255,255,255,0.75), 0 12px 40px rgba(20,40,80,0.08)",
        lift: "inset 1px 1px 0 rgba(255,255,255,0.8), 0 18px 50px rgba(20,40,80,0.12)",
      },
      fontSize: { "2xs": ["11px", "14px"] },
    },
  },
  plugins: [],
};
