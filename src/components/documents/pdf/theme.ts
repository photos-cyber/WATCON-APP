import path from "node:path";
import { Font, StyleSheet } from "@react-pdf/renderer";
import type { PdfTone } from "./types";

/**
 * Design tokens for every WATCON PDF. Noto Sans (SIL OFL, bundled in src/assets/fonts) is used
 * because the PDF built-in Helvetica has no ₹ glyph. Fonts are read from disk on the server only.
 */
const FONT_DIR = path.join(process.cwd(), "src", "assets", "fonts");
let registered = false;
export function registerPdfFonts() {
  if (registered) return;
  Font.register({
    family: "NotoSans",
    fonts: [
      { src: path.join(FONT_DIR, "NotoSans-Regular.ttf"), fontWeight: 400 },
      { src: path.join(FONT_DIR, "NotoSans-SemiBold.ttf"), fontWeight: 600 },
      { src: path.join(FONT_DIR, "NotoSans-Bold.ttf"), fontWeight: 700 },
    ],
  });
  // No automatic hyphenation: item codes, GSTINs and numbers must never be split with "-".
  Font.registerHyphenationCallback((word) => [word]);
  registered = true;
}

export const C = {
  ink: "#1F2933",
  body: "#323F4B",
  muted: "#66727F",
  faint: "#9AA5B1",
  navy: "#14284B",
  navySoft: "#E8EDF5",
  accent: "#D7262F",
  rule: "#D5DBE3",
  ruleSoft: "#E9EDF2",
  zebra: "#F7F9FB",
  white: "#FFFFFF",
};

export const TONES: Record<PdfTone, { fg: string; bg: string; border: string }> = {
  draft: { fg: "#7A5B00", bg: "#FFF6D6", border: "#E9CF73" },
  pending: { fg: "#8A4B00", bg: "#FFEEDB", border: "#F0B877" },
  approved: { fg: "#13603A", bg: "#E3F4EA", border: "#8CCBA6" },
  done: { fg: "#1D4E89", bg: "#E5EEFA", border: "#9DBDE6" },
  cancelled: { fg: "#9B1C1C", bg: "#FDE8E8", border: "#EFA3A3" },
  neutral: { fg: "#3E4C59", bg: "#EEF1F4", border: "#C5CDD6" },
};

/** Page geometry (points). A4 = 595.28 × 841.89. */
export const PAGE = { padTop: 40, padBottom: 50, padX: 34 };

export const S = StyleSheet.create({
  // No page-level lineHeight: with it, react-pdf drops fixed blocks that contain a `render`
  // text (the "Page X of Y" footer). Noto Sans' own line metrics give ~1.36 spacing anyway.
  page: { paddingTop: PAGE.padTop, paddingBottom: PAGE.padBottom, paddingHorizontal: PAGE.padX, fontFamily: "NotoSans", fontSize: 8.4, color: C.body },
  label: { fontSize: 6.6, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 },
  small: { fontSize: 7.2, color: C.muted },
  strong: { fontWeight: 700, color: C.ink },
  semibold: { fontWeight: 600, color: C.ink },
  sectionTitle: { fontSize: 7.4, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 3 },
  card: { borderWidth: 0.6, borderColor: C.rule, borderRadius: 3, paddingVertical: 5, paddingHorizontal: 8, flexGrow: 1, flexBasis: 0 },
});
