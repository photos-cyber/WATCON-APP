import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";

const FILES = { pdf: ["WATCON_USER_GUIDE.pdf", "application/pdf"], quick: ["QUICK_START_GUIDE.pdf", "application/pdf"], docx: ["WATCON_USER_GUIDE.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] } as const;
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  if (user.mustChangePassword) return NextResponse.json({ error: "Password change required" }, { status: 403 });
  if (user.role !== "SUPER_ADMIN") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const format = request.nextUrl.searchParams.get("format") ?? "pdf";
  if (!(format in FILES)) return NextResponse.json({ error: "Unknown manual format" }, { status: 400 });
  const [name, type] = FILES[format as keyof typeof FILES];
  try {
    const bytes = await readFile(path.join(process.cwd(), "docs", "user-guide", name));
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return NextResponse.json({ error: "The manual is temporarily unavailable. Contact your administrator." }, { status: 503 });
  }
}
