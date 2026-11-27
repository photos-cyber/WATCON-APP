/**
 * Mandatory receiving proof (workflow v2 · Phase 4). Client-safe: the receipt page shows the same
 * checklist the server enforces on submit and post.
 *
 * Supplier receipts (against a purchase order):
 *   - at least one material photo (an image file);
 *   - the supplier's delivery challan, invoice or other delivery proof (image or PDF);
 *   - when anything is damaged or rejected: at least one photo of the damaged / rejected material.
 * Site receipts of an internal challan (issue to site, site-to-site, return to store) — Phase 5:
 *   - at least one material photo;
 *   - the signed challan or equivalent delivery proof;
 *   - when anything is damaged: at least one damage photo.
 */

export type ProofSlotKey = "photo" | "delivery" | "signed" | "damage";

export type ProofSlot = {
  key: ProofSlotKey;
  label: string;
  help: string;
  /** Category new uploads in this slot are saved under. */
  uploadCategory: "MATERIAL_PHOTO" | "DELIVERY_CHALLAN" | "SIGNED_CHALLAN" | "DAMAGE_PHOTO";
  /** Categories that satisfy the slot. */
  categories: readonly string[];
  imageOnly: boolean;
  accept: string;
};

export const PROOF_SLOTS: Record<ProofSlotKey, ProofSlot> = {
  photo: { key: "photo", label: "Material photos", help: "Photos of the material as it arrived (labels / quantity visible).", uploadCategory: "MATERIAL_PHOTO", categories: ["MATERIAL_PHOTO"], imageOnly: true, accept: "image/*" },
  delivery: { key: "delivery", label: "Supplier delivery challan", help: "The supplier's delivery challan, invoice or other delivery proof (photo or PDF).", uploadCategory: "DELIVERY_CHALLAN", categories: ["DELIVERY_CHALLAN", "SIGNED_CHALLAN", "SUPPLIER_INVOICE"], imageOnly: false, accept: "image/*,application/pdf" },
  signed: { key: "signed", label: "Signed challan", help: "The challan signed by the receiver at site, or equivalent delivery proof (photo or PDF).", uploadCategory: "SIGNED_CHALLAN", categories: ["SIGNED_CHALLAN", "DELIVERY_CHALLAN"], imageOnly: false, accept: "image/*,application/pdf" },
  damage: { key: "damage", label: "Damaged / rejected material", help: "Photos of the damaged or rejected material (needed because some quantity was damaged or rejected).", uploadCategory: "DAMAGE_PHOTO", categories: ["DAMAGE_PHOTO"], imageOnly: true, accept: "image/*" },
};

export type ProofFile = { id: string; category: string; mimeType: string; fileName: string };

export type ProofStatus = { required: (ProofSlot & { files: ProofFile[]; met: boolean })[]; complete: boolean; missing: string[] };

/** Which slots a receipt needs, and whether the uploaded (non-deleted) files satisfy them. */
export function evaluateProof(receipt: { poId: string | null; challanId?: string | null; lines: { damagedQty: string; rejectedQty: string }[] }, files: ProofFile[]): ProofStatus {
  if (!receipt.poId && !receipt.challanId) return { required: [], complete: true, missing: [] };
  const needDamage = receipt.lines.some((l) => Number(l.damagedQty) > 0 || Number(l.rejectedQty) > 0);
  const slots = [PROOF_SLOTS.photo, receipt.poId ? PROOF_SLOTS.delivery : PROOF_SLOTS.signed, ...(needDamage ? [PROOF_SLOTS.damage] : [])];
  const required = slots.map((s) => {
    const matching = files.filter((f) => s.categories.includes(f.category) && (!s.imageOnly || f.mimeType.startsWith("image/")));
    return { ...s, files: matching, met: matching.length > 0 };
  });
  const missing = required.filter((r) => !r.met).map((r) => r.label);
  return { required, complete: missing.length === 0, missing };
}

export function missingProofMessage(missing: string[]) {
  return `Add the mandatory proof before submitting: ${missing.join("; ")}.`;
}
