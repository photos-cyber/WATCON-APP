/**
 * Typed application errors. Services throw these; server actions / route handlers
 * convert them into safe responses. Unknown errors are logged server-side and
 * surfaced to the client only as a generic message (no stack traces).
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "VALIDATION" | "CONFLICT" | "RATE_LIMITED",
    public readonly status: number,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Please sign in to continue.") {
    super(message, "UNAUTHENTICATED", 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action.") {
    super(message, "FORBIDDEN", 403);
  }
}

/** Also used when a record exists but the actor may not see it (prevents IDOR probing). */
export class NotFoundError extends AppError {
  constructor(entity = "Record") {
    super(`${entity} not found.`, "NOT_FOUND", 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message, "VALIDATION", 400, fieldErrors);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message, "CONFLICT", 409, fieldErrors);
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many attempts. Please wait a few minutes and try again.") {
    super(message, "RATE_LIMITED", 429);
  }
}

export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string; code?: AppError["code"]; fieldErrors?: Record<string, string> };

type ZodLikeIssue = { path: PropertyKey[]; message: string };

export function zodFieldErrors(issues: readonly ZodLikeIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".") || "_form";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

/** Prisma unique-constraint violation detection without importing Prisma runtime here. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "P2002";
}

export function toActionError(e: unknown): Extract<ActionResult, { ok: false }> {
  if (e instanceof AppError) {
    return { ok: false, error: e.message, code: e.code, fieldErrors: e.fieldErrors };
  }
  if (isUniqueViolation(e)) {
    return { ok: false, error: "A record with the same unique value already exists.", code: "CONFLICT" };
  }
  // P2028 = interactive transaction timed out / could not start. Nothing was saved (rolled back).
  if (typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "P2028") {
    console.error("[transaction-timeout]", e);
    return { ok: false, error: "The database took too long to respond, so nothing was saved. Please try again in a moment." };
  }
  console.error("[unexpected-error]", e);
  return { ok: false, error: "Something went wrong. Please try again." };
}
