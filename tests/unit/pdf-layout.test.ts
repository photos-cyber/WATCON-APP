import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { CommercialPdf } from "@/components/documents/commercial-pdf";
import type { PdfDoc } from "@/components/documents/pdf/types";
import { ReportPdf } from "@/components/reports/report-pdf";
import { amountInWords } from "@/lib/money";
import { docState, pdfFileName, rs, termsSection } from "@/modules/documents/pdf-format";
import { challanFixture, creditNoteFixture, grnFixture, invoiceFixture, LONG_TERMS, ORG, paymentFixture, poFixture, raBillFixture } from "./pdf-fixtures";

/**
 * Renders representative documents and checks page geometry and pagination. Set
 * PDF_SAMPLES_DIR to also write the PDFs for visual review (scripts/pdf-to-png.mjs).
 */

const OUT = process.env.PDF_SAMPLES_DIR;
const A4 = { w: 595.28, h: 841.89 };

async function render(name: string, doc: PdfDoc) {
  const buf = Buffer.from(await renderToBuffer(createElement(CommercialPdf, { doc }) as Parameters<typeof renderToBuffer>[0]));
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, `${name}.pdf`), buf);
  }
  const raw = buf.toString("latin1");
  const pages = (raw.match(/\/Type \/Page[^s]/g) ?? []).length;
  const boxes = [...raw.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
  return { buf, pages, boxes };
}

const CASES: [string, () => PdfDoc, { pages: number | [number, number]; landscape?: boolean }][] = [
  ["po-single-item", () => poFixture({ lines: 1 }), { pages: 1 }],
  ["po-multi-item-freight-roundoff", () => poFixture({ lines: 8, freight: "3500", longText: true, revision: 2 }), { pages: [1, 2] }],
  ["po-60-items", () => poFixture({ lines: 60 }), { pages: [3, 5] }],
  ["po-draft-missing-optional", () => poFixture({ lines: 3, status: "DRAFT", terms: null, missingOptional: true }), { pages: 1 }],
  ["po-interstate-large", () => poFixture({ lines: 6, inter: true, freight: "125000" }), { pages: 1 }],
  ["po-long-terms", () => poFixture({ lines: 4, terms: LONG_TERMS }), { pages: [2, 3] }],
  ["invoice-igst-bank", () => invoiceFixture(), { pages: 1 }],
  ["invoice-draft-no-signature", () => invoiceFixture("DRAFT"), { pages: 1 }],
  ["ra-bill-landscape", raBillFixture, { pages: [1, 2], landscape: true }],
  ["grn-discrepancies", grnFixture, { pages: 1 }],
  ["challan-issue", challanFixture, { pages: 1 }],
  ["payment-voucher", paymentFixture, { pages: 1 }],
  ["credit-note-cancelled", creditNoteFixture, { pages: 1 }],
];

describe("commercial PDF layout", () => {
  for (const [name, make, exp] of CASES) {
    it(`${name}: A4, expected page count`, async () => {
      const { pages, boxes } = await render(name, make());
      expect(boxes.length).toBe(pages);
      for (const [w, h] of boxes) {
        const [ew, eh] = exp.landscape ? [A4.h, A4.w] : [A4.w, A4.h];
        expect(w).toBeCloseTo(ew, 1);
        expect(h).toBeCloseTo(eh, 1);
      }
      if (typeof exp.pages === "number") expect(pages).toBe(exp.pages);
      else {
        expect(pages).toBeGreaterThanOrEqual(exp.pages[0]);
        expect(pages).toBeLessThanOrEqual(exp.pages[1]);
      }
    }, 30_000);
  }

  it("100 lines paginate without a blank trailing page", async () => {
    const small = await render("po-100-items", poFixture({ lines: 100 }));
    const fewer = await render("po-99-items", poFixture({ lines: 99 }));
    expect(small.pages).toBeGreaterThanOrEqual(4);
    // One extra line can add at most one page — never an empty one.
    expect(small.pages - fewer.pages).toBeLessThanOrEqual(1);
  }, 60_000);
});

describe("task report PDF", () => {
  it("renders landscape A4 with the shared letterhead and paginates 150 tasks", async () => {
    const statuses = ["TODO", "IN_PROGRESS", "COMPLETED", "BLOCKED"] as const;
    const tasks = Array.from({ length: 150 }, (_, i) => ({
      id: `t${i}`,
      code: `TSK-${String(i + 1).padStart(4, "0")}`,
      title: `Inspect filtration line section ${i + 1}`,
      description: i % 5 === 0 ? "Check flanges, gaskets and pressure gauges; record readings in the site log and raise a defect if any reading is outside tolerance." : null,
      project: { name: "PRJ-0087 – Demo Pool Site" },
      assignees: [{ user: { fullName: "Site Engineer" } }],
      departments: [{ department: { name: "Projects" } }],
      priority: "MEDIUM",
      status: statuses[i % 4],
      dueDate: new Date("2026-12-01"),
      progress: (i * 7) % 100,
    }));
    const report = { type: "project", title: "Project report", subject: "PRJ-0087 – Demo Pool Site", details: [{ label: "Status", value: "Active" }], organization: { name: ORG.name, logoDataUrl: ORG.logoDataUrl, address: ORG.address }, generatedAt: new Date("2026-11-23T10:00:00Z"), generatedBy: "Sana Arif", tasks, truncated: false, whatsappPhone: null, fileName: "project-report" };
    const buf = Buffer.from(await renderToBuffer(createElement(ReportPdf, { report: report as never, org: ORG }) as Parameters<typeof renderToBuffer>[0]));
    if (OUT) writeFileSync(path.join(OUT, "task-report.pdf"), buf);
    const raw = buf.toString("latin1");
    const pages = (raw.match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(5);
    for (const m of raw.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)) {
      expect(Number(m[1])).toBeCloseTo(A4.h, 1);
      expect(Number(m[2])).toBeCloseTo(A4.w, 1);
    }
  }, 60_000);
});

describe("PDF formatting helpers", () => {
  it("formats INR with Indian grouping", () => {
    expect(rs("105817.68")).toBe("₹1,05,817.68");
    expect(rs("123456789.5")).toBe("₹12,34,56,789.50");
    expect(rs("-1680.56")).toBe("-₹1,680.56");
  });

  it("amount in words includes paise and matches the figure", () => {
    expect(amountInWords("363015.56")).toBe("Rupees Three Lakh Sixty Three Thousand Fifteen and Fifty Six Paise Only");
    expect(amountInWords("100000")).toBe("Rupees One Lakh Only");
  });

  it("marks drafts, pending, cancelled and final documents correctly", () => {
    expect(docState("DRAFT")).toMatchObject({ watermark: "DRAFT", final: false });
    expect(docState("PENDING_APPROVAL")).toMatchObject({ watermark: "PENDING APPROVAL", final: false });
    expect(docState("CANCELLED")).toMatchObject({ watermark: "CANCELLED", final: false });
    expect(docState("REJECTED")).toMatchObject({ watermark: "REJECTED", final: false });
    expect(docState("APPROVED")).toMatchObject({ watermark: null, final: true });
    expect(docState("SUBMITTED", { pending: ["SUBMITTED"] })).toMatchObject({ final: false });
  });

  it("builds safe file names from the real document number", () => {
    expect(pdfFileName(ORG, { number: "PO/2026-27/0001" })).toBe("WATCON_PO_2026-27_0001.pdf");
    expect(pdfFileName(ORG, { number: "SO/2026-27/0001", revision: 2 })).toBe("WATCON_SO_2026-27_0001_Rev2.pdf");
    expect(pdfFileName({ ...ORG, name: "Évil \"Co\"" }, { number: '../x"; rm' })).toMatch(/^[A-Z0-9]+_[A-Za-z0-9._-]+\.pdf$/);
  });

  it("splits one-clause-per-line terms into numbered items", () => {
    expect(termsSection("Terms", "1. A\n2) B\n- C")).toEqual({ title: "Terms", items: ["A", "B", "C"] });
    expect(termsSection("Terms", "Single paragraph")).toEqual({ title: "Terms", body: "Single paragraph" });
    expect(termsSection("Terms", "  ")).toBeNull();
  });
});
