import { renderToBuffer } from "@react-pdf/renderer";
import { NextResponse, type NextRequest } from "next/server";
import { createElement } from "react";
import { CommercialPdf } from "@/components/documents/commercial-pdf";
import { db } from "@/lib/db";
import { pdfFileName } from "@/modules/documents/pdf-kit";
import { quotationPdf } from "@/modules/sales/pdf";

/**
 * GET /client-quote/<token>/pdf — the client's PDF of their quotation. The token identifies one
 * quotation; it is rendered with the same builder as the staff PDF, under a read-only system
 * identity scoped to that organisation (never other documents).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{64}$/.test(token)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const q = await db.clientQuotation.findUnique({ where: { accessToken: token }, select: { id: true, organizationId: true, status: true, createdById: true } });
  if (!q || ["DRAFT", "PENDING_APPROVAL", "CANCELLED"].includes(q.status)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Read-only actor limited to viewing sales documents of this organisation, used only to build this one PDF.
  const viewer = { id: q.createdById, organizationId: q.organizationId, role: "VIEWER" as const, permissions: ["so.view", "projects.view_all"] };
  try {
    const doc = await quotationPdf(viewer as never, q.id);
    const buffer = await renderToBuffer(createElement(CommercialPdf, { doc }) as Parameters<typeof renderToBuffer>[0]);
    const name = pdfFileName(doc.org, doc);
    return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
  } catch (e) {
    console.error("[client-quote-pdf]", e);
    return NextResponse.json({ error: "Could not generate the PDF." }, { status: 500 });
  }
}
