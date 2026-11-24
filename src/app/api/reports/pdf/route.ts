import { renderToBuffer } from "@react-pdf/renderer";
import { NextResponse, type NextRequest } from "next/server";
import { createElement } from "react";
import { ReportPdf } from "@/components/reports/report-pdf";
import { getSessionUser } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { loadPdfOrg } from "@/modules/documents/pdf-kit";
import { getReport } from "@/modules/reports/service";

/** GET /api/reports/pdf?type=project&id=…[&inline=1] — authorized PDF export (read-only). */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (user.mustChangePassword) return NextResponse.json({ error: "Password change required" }, { status: 403 });
  try {
    const params = Object.fromEntries(request.nextUrl.searchParams.entries());
    const [report, org] = await Promise.all([getReport(user, params), loadPdfOrg(user.organizationId)]);
    const buffer = await renderToBuffer(createElement(ReportPdf, { report, org }) as Parameters<typeof renderToBuffer>[0]);
    const date = new Date().toISOString().slice(0, 10);
    const company = (org.name.split(/\s+/)[0] ?? "REPORT").toUpperCase().replace(/[^A-Z0-9]/g, "") || "REPORT";
    const name = `${company}_${report.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}_${date}.pdf`;
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
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status === 403 ? 404 : e.status });
    console.error("[pdf-export]", e);
    return NextResponse.json({ error: "Could not generate the PDF." }, { status: 500 });
  }
}
