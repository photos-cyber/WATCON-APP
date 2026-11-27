import { z } from "zod";
import { dateString, optionalDate, optionalText, text, uuid } from "@/lib/validations/common";

const status = z.enum(["ACTIVE", "INACTIVE"]);

export const ITEM_UNITS = ["Nos", "Kg", "Gm", "Ton", "Ltr", "Mtr", "Ft", "Sqft", "Sqm", "Cum", "Set", "Box", "Bag", "Roll", "Pair", "Pkt", "Coil", "Drum"] as const;

/** Blank → generated automatically. Stored upper-cased. */
const itemCode = z
  .string()
  .trim()
  .toUpperCase()
  .max(30, "Item code must be at most 30 characters.")
  .regex(/^$|^[A-Z0-9][A-Z0-9._/-]*$/, "Use letters, numbers, dot, slash, underscore or hyphen.")
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

export const itemInputSchema = z.object({
  code: itemCode,
  name: text("Item name", 120, 2),
  category: optionalText("Category", 60),
  unit: text("Unit", 20),
  description: optionalText("Description", 1000),
  status: status.default("ACTIVE"),
});
export type ItemInput = z.input<typeof itemInputSchema>;

export const brandInputSchema = z.object({
  name: text("Brand name", 80),
  description: optionalText("Description", 1000),
  status: status.default("ACTIVE"),
});
export type BrandInput = z.input<typeof brandInputSchema>;

/** Positive decimal with at most 3 decimal places, kept as a string so no float rounding happens. */
const quantityString = z
  .string()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, "Enter a quantity with up to 3 decimal places.")
  .refine((v) => Number(v) > 0, "Quantity must be greater than zero.");

export const quantity = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(quantityString);

const idempotencyKey = z.string().uuid("Invalid submission key.");

export const linkBrandSchema = z.object({
  itemId: uuid,
  brandId: uuid,
  openingQty: z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v) => (v === undefined || v === null || String(v).trim() === "" || Number(v) === 0 ? null : String(v).trim()))
    .pipe(z.union([z.null(), quantityString])),
  openingDate: optionalDate,
});
export type LinkBrandInput = z.input<typeof linkBrandSchema>;

export const MOVEMENT_TYPES = ["INWARD", "OUTWARD", "ADJUSTMENT"] as const;

export const movementSchema = z
  .object({
    itemBrandId: uuid,
    /** Optional; defaults to the Central Warehouse. */
    locationId: uuid.optional().nullable().or(z.literal("")).transform((v) => (v ? v : null)),
    type: z.enum(MOVEMENT_TYPES),
    /** Only used for ADJUSTMENT (IN = increase, OUT = decrease). */
    direction: z.enum(["IN", "OUT"]).optional().nullable(),
    quantity,
    txnDate: dateString,
    reference: optionalText("Reference", 80),
    remarks: optionalText("Remarks", 500),
    reason: optionalText("Reason", 500),
    idempotencyKey,
  })
  .superRefine((v, ctx) => {
    if (v.type === "ADJUSTMENT" && !v.direction) ctx.addIssue({ code: "custom", path: ["direction"], message: "Choose whether the adjustment increases or decreases stock." });
    // Every manual stock change needs a reason (workflow v2: owner-only, with evidence).
    if (!v.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "A reason is mandatory for manual stock changes." });
  });
export type MovementInput = z.input<typeof movementSchema>;

const q = z.string().trim().max(100).optional().catch(undefined);
const page = z.coerce.number().int().min(1).catch(1).default(1);
const pageSize = z.coerce.number().int().min(5).max(100).catch(20).default(20);
const dir = z.enum(["asc", "desc"]).catch("asc").default("asc");
const optUuid = uuid.optional().catch(undefined);
const optDay = dateString.optional().catch(undefined);

export const itemListQuerySchema = z.object({
  q,
  status: status.optional().catch(undefined),
  category: z.string().trim().max(60).optional().catch(undefined),
  sort: z.enum(["name", "code", "category", "createdAt"]).catch("name").default("name"),
  dir,
  page,
  pageSize,
});

export const brandListQuerySchema = z.object({
  q,
  status: status.optional().catch(undefined),
  sort: z.enum(["name", "code", "createdAt"]).catch("name").default("name"),
  dir,
  page,
  pageSize,
});

export const stockQuerySchema = z.object({
  q,
  itemId: optUuid,
  brandId: optUuid,
  category: z.string().trim().max(60).optional().catch(undefined),
  from: optDay,
  to: optDay,
  page,
  pageSize,
});

export const ledgerQuerySchema = z.object({
  q,
  itemId: optUuid,
  brandId: optUuid,
  type: z.enum(["OPENING", "INWARD", "OUTWARD", "ADJUSTMENT", "RECEIPT", "TRANSFER_OUT", "TRANSFER_IN", "RETURN_TO_SUPPLIER", "CLIENT_DELIVERY", "CONSUMPTION", "WRITE_OFF", "REVERSAL"]).optional().catch(undefined),
  locationId: optUuid,
  projectId: optUuid,
  from: optDay,
  to: optDay,
  page,
  pageSize,
});
