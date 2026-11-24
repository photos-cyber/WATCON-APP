import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { AppError, toActionError } from "@/lib/errors";
import { maxUploadBytes } from "@/lib/storage";
import { uploadAttachment } from "@/modules/documents/attachments";
import { isUploadOriginAllowed } from "@/lib/upload-origin";

/**
 * POST /api/attachments (multipart) — uploads one evidence file to a record.
 * Route handlers don't get Server Actions' built-in origin check, so it is done here:
 * cross-site form posts are rejected even though the session cookie is SameSite=Lax.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!isUploadOriginAllowed(origin, host)) return NextResponse.json({ ok: false, error: "Cross-origin upload rejected." }, { status: 403 });

  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "Please sign in again." }, { status: 401 });
  if (user.mustChangePassword) return NextResponse.json({ ok: false, error: "Password change required." }, { status: 403 });

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxUploadBytes() + 64 * 1024) return NextResponse.json({ ok: false, error: `Files must be ${Math.round(maxUploadBytes() / 1048576)} MB or smaller.` }, { status: 413 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid upload." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "Choose a file to upload.", fieldErrors: { file: "Choose a file." } }, { status: 400 });
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v !== "" ? v : null;
  };

  try {
    const row = await uploadAttachment(user, {
      entityType: field("entityType") ?? "",
      entityId: field("entityId") ?? "",
      category: (field("category") ?? "OTHER") as never,
      description: field("description"),
      replacesId: field("replacesId"),
      latitude: field("latitude") as never,
      longitude: field("longitude") as never,
      accuracyM: field("accuracyM") as never,
      capturedAt: field("capturedAt"),
      fileName: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return NextResponse.json({ ok: true, data: row });
  } catch (e) {
    const err = toActionError(e);
    const status = e instanceof AppError ? (e.status === 403 ? 403 : e.status) : 500;
    return NextResponse.json(err, { status });
  }
}
