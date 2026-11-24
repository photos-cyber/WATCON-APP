import "server-only";
import { z } from "zod";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { dec2, dec3, dec4, parseInput } from "@/modules/commercial/core";
import { todayString } from "@/modules/inventory/serialize";
import { persistQuotation, quotationSchema } from "./rfq";

/**
 * Supplier quote links. Each invited supplier gets a secret link (/quote/<token>) and fills in
 * their own rates without logging in. The token is the only credential: it identifies exactly one
 * supplier on one enquiry, and the page never shows other suppliers' rates.
 */

const OPEN = ["DRAFT", "SENT", "RESPONSES_IN"];
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);

async function findInvite(token: string) {
  if (!tokenSchema.safeParse(token).success) return null;
  return db.rfqSupplier.findUnique({
    where: { accessToken: token },
    include: {
      party: { select: { id: true, name: true } },
      rfq: {
        include: {
          organization: { select: { name: true, phone: true, email: true } },
          project: { select: { name: true } },
          lines: { orderBy: { lineNo: "asc" }, include: { item: { select: { name: true, unit: true } }, itemBrand: { include: { brand: { select: { name: true } } } } } },
        },
      },
    },
  });
}

export async function getPortalQuote(token: string) {
  const invite = await findInvite(token);
  if (!invite) return null;
  const { rfq } = invite;
  if (!invite.viewedAt) await db.rfqSupplier.update({ where: { id: invite.id }, data: { viewedAt: new Date() } });
  const brands = await db.itemBrand.findMany({ where: { organizationId: rfq.organizationId, itemId: { in: rfq.lines.map((l) => l.itemId) } }, include: { brand: { select: { name: true } } }, orderBy: { brand: { name: "asc" } } });
  const current = await db.supplierQuotation.findFirst({ where: { rfqId: rfq.id, partyId: invite.partyId, status: { in: ["RECEIVED", "AWARDED"] } }, orderBy: { createdAt: "desc" }, include: { lines: true } });
  return {
    company: rfq.organization,
    supplier: invite.party.name,
    rfq: {
      number: rfq.number,
      title: rfq.title,
      project: rfq.project?.name ?? null,
      responseDue: rfq.responseDue?.toISOString().slice(0, 10) ?? null,
      requiredBy: rfq.requiredBy?.toISOString().slice(0, 10) ?? null,
      deliveryAddress: rfq.deliveryAddress,
      paymentTerms: rfq.paymentTerms,
      freightTerms: rfq.freightTerms,
      taxTerms: rfq.taxTerms,
      specifications: rfq.specifications,
    },
    open: OPEN.includes(rfq.status) && current?.status !== "AWARDED",
    lines: rfq.lines.map((l) => ({
      id: l.id,
      name: l.item.name,
      unit: l.unit,
      quantity: dec3(l.quantity),
      requestedBrand: l.itemBrand?.brand.name ?? null,
      requestedBrandId: l.itemBrandId,
      acceptableBrands: l.acceptableBrands,
      specifications: l.specifications,
      brands: brands.filter((b) => b.itemId === l.itemId).map((b) => ({ id: b.id, name: b.brand.name })),
    })),
    current: current
      ? {
          number: current.number,
          revision: current.revision,
          submittedAt: current.createdAt.toISOString(),
          supplierRef: current.supplierRef ?? "",
          validUntil: current.validUntil?.toISOString().slice(0, 10) ?? "",
          deliveryDays: current.deliveryDays != null ? String(current.deliveryDays) : "",
          freight: dec2(current.freight),
          freightGstRate: String(Number(dec2(current.freightGstRate))),
          paymentTerms: current.paymentTerms ?? "",
          advancePct: current.advancePct ? String(Number(current.advancePct)) : "",
          creditDays: current.creditDays != null ? String(current.creditDays) : "",
          warranty: current.warranty ?? "",
          remarks: current.remarks ?? "",
          lines: current.lines.map((l) => ({ rfqLineId: l.rfqLineId, itemBrandId: l.itemBrandId, quantity: dec3(l.quantity), rate: dec4(l.rate), discountPct: dec2(l.discountPct), gstRate: String(Number(dec2(l.gstRate))), leadTimeDays: l.leadTimeDays != null ? String(l.leadTimeDays) : "", remarks: l.remarks ?? "", paymentTerms: l.paymentTerms ?? "" })),
        }
      : null,
  };
}

const portalSchema = quotationSchema.omit({ rfqId: true, partyId: true, replacesId: true });

export async function submitPortalQuote(token: string, input: unknown) {
  const invite = await findInvite(token);
  if (!invite) throw new NotFoundError("Quote link");
  const { rfq } = invite;
  if (!OPEN.includes(rfq.status)) throw new ValidationError("This enquiry is closed for quotations. Please contact the buyer.");
  const body = parseInput(portalSchema, { ...(input as object), quoteDate: todayString() });
  return db.$transaction(async (tx) => {
    const current = await tx.supplierQuotation.findFirst({ where: { rfqId: rfq.id, partyId: invite.partyId, status: { in: ["RECEIVED", "AWARDED"] } }, orderBy: { createdAt: "desc" } });
    if (current?.status === "AWARDED") throw new ValidationError("Your quotation has already been awarded and can no longer be changed.");
    const q = await persistQuotation(tx, {
      organizationId: rfq.organizationId,
      rfq,
      data: { ...body, rfqId: rfq.id, partyId: invite.partyId, replacesId: current?.id ?? null },
      createdById: rfq.createdById,
      actorId: null,
      viaPortal: true,
    });
    await tx.rfqSupplier.update({ where: { id: invite.id }, data: { sentAt: invite.sentAt ?? new Date(), sentVia: invite.sentVia ?? "link" } });
    await tx.notification.create({
      data: { userId: rfq.createdById, type: "rfq_quote", title: `${invite.party.name} ${current ? "revised their" : "sent a"} quotation for ${rfq.number}`, body: rfq.title, link: `/rate-enquiries/${rfq.id}` },
    });
    return { number: q.number, revision: q.revision };
  });
}
