// Dev QA tool: renders every page of a PDF to PNG so layouts can be inspected visually.
// Usage: node scripts/pdf-to-png.mjs <file.pdf> [outDir] [scale]
// Uses the project's Playwright Chromium + pdf.js (loaded from cdnjs). Not used by the app.
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [file, outDir = path.dirname(file ?? "."), scale = "1.6"] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node scripts/pdf-to-png.mjs <file.pdf> [outDir] [scale]");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const b64 = readFileSync(file).toString("base64");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<html><body style="margin:0;background:#888"><script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script></body></html>`);
await page.waitForFunction(() => "pdfjsLib" in window);
const info = await page.evaluate(
  async ({ b64, scale }) => {
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const pdf = await lib.getDocument({ data: bytes }).promise;
    const sizes = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      const vp = p.getViewport({ scale: Number(scale) });
      const c = document.createElement("canvas");
      c.width = vp.width;
      c.height = vp.height;
      c.id = `p${i}`;
      c.style.display = "block";
      c.style.marginBottom = "8px";
      document.body.appendChild(c);
      await p.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      const base = p.getViewport({ scale: 1 });
      sizes.push([Math.round(base.width * 100) / 100, Math.round(base.height * 100) / 100]);
    }
    return { pages: pdf.numPages, sizes };
  },
  { b64, scale },
);
const stem = path.basename(file, ".pdf");
for (let i = 1; i <= info.pages; i++) {
  await page.locator(`#p${i}`).screenshot({ path: path.join(outDir, `${stem}-p${i}.png`) });
}
console.log(JSON.stringify({ file: stem, pages: info.pages, sizesPt: info.sizes }));
await browser.close();
