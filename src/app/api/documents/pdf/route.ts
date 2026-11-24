import { renderToBuffer } from "@react-pdf/renderer";
import { NextResponse, type NextRequest } from "next/server";
import { createElement } from "react";
import { CommercialPdf } from "@/components/documents/commercial-pdf";
import { getSessionUser } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { pdfFileName } from "@/modules/documents/pdf-kit";
import { buildPdfModel } from "@/modules/documents/pdf-models";

/** GET /api/documents/pdf?type=purchase_order&id=…[&inline=1] — authorised commercial document PDF. */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (user.mustChangePassword) return NextResponse.json({ error: "Password change required" }, { status: 403 });
  const type = request.nextUrl.searchParams.get("type") ?? "";
  const id = request.nextUrl.searchParams.get("id") ?? "";
  try {
    const doc = await buildPdfModel(user, type, id);
    // Always rendered from the current saved record (no caching), so a stale revision can't be exported.
    const buffer = await renderToBuffer(createElement(CommercialPdf, { doc }) as Parameters<typeof renderToBuffer>[0]);
    const name = pdfFileName(doc.org, doc);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${request.nextUrl.searchParams.get("inline") === "1" ? "inline" : "attachment"}; filename="${name}"`,
        "X-Document-Filename": name,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.status === 403 ? "Not found" : e.message }, { status: e.status === 403 ? 404 : e.status });
    console.error("[document-pdf]", e);
    return NextResponse.json({ error: "Could not generate the PDF." }, { status: 500 });
  }
}
