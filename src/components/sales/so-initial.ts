import type { SoFormValues, SoLine } from "./so-form";

type SoLike = {
  projectId: string;
  partyId: string;
  clientPoId: string | null;
  orderDate: Date;
  deliveryDate: Date | null;
  deliveryAddress: string | null;
  deliverySchedule: string | null;
  billingSchedule: string | null;
  paymentTerms: string | null;
  notes: string | null;
  lines: { id: string; clientPoLineId: string | null; itemBrandId: string | null; kind?: "MATERIAL" | "SERVICE" | "INSTALLATION"; description: string | null; hsnSac: string | null; unit: string | null; quantity: string; rate: string; discountPct: string; gstRate: string; deliveredQty: string; invoicedQty: string }[];
};

/** Form values for editing a draft order, or proposing an amendment to an approved one. */
export function soInitial(so: SoLike): SoFormValues {
  return {
    projectId: so.projectId,
    partyId: so.partyId,
    clientPoId: so.clientPoId,
    orderDate: so.orderDate.toISOString().slice(0, 10),
    deliveryDate: so.deliveryDate?.toISOString().slice(0, 10) ?? "",
    deliveryAddress: so.deliveryAddress ?? "",
    deliverySchedule: so.deliverySchedule ?? "",
    billingSchedule: so.billingSchedule ?? "",
    paymentTerms: so.paymentTerms ?? "",
    notes: so.notes ?? "",
    lines: soLines(so.lines),
  };
}

export function soLines(lines: SoLike["lines"]): SoLine[] {
  return lines.map((l) => {
    const floor = Math.max(Number(l.deliveredQty), Number(l.invoicedQty));
    return {
      key: l.id,
      id: l.id,
      clientPoLineId: l.clientPoLineId,
      itemBrandId: l.itemBrandId,
      kind: l.kind ?? null,
      description: l.description ?? "",
      hsnSac: l.hsnSac ?? "",
      unit: l.unit ?? "",
      quantity: l.quantity,
      rate: l.rate,
      discountPct: l.discountPct,
      gstRate: String(Number(l.gstRate)),
      floor: floor > 0 ? String(floor) : undefined,
      note: floor > 0 ? `Delivered ${Number(l.deliveredQty)} · invoiced ${Number(l.invoicedQty)} — quantity cannot go below ${floor}` : undefined,
    };
  });
}
