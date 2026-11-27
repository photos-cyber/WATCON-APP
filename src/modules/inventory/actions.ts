"use server";

import { runAction } from "@/lib/actions";
import { createBrand, createItem, linkBrand, postStockMovement, setBrandStatus, setItemStatus, unlinkBrand, updateBrand, updateItem } from "./service";

const INVENTORY = ["/items", "/brands", "/stock"];
const status = (s: string) => (s === "ACTIVE" ? "ACTIVE" : "INACTIVE");

export async function createItemAction(input: unknown) {
  return runAction(async (actor) => ({ id: (await createItem(actor, input)).id }), INVENTORY);
}

export async function updateItemAction(id: string, input: unknown) {
  return runAction(async (actor) => ({ id: (await updateItem(actor, String(id), input)).id }), INVENTORY);
}

export async function setItemStatusAction(id: string, s: "ACTIVE" | "INACTIVE") {
  return runAction(async (actor) => {
    await setItemStatus(actor, String(id), status(s));
  }, INVENTORY);
}

export async function createBrandAction(input: unknown) {
  return runAction(async (actor) => ({ id: (await createBrand(actor, input)).id }), INVENTORY);
}

export async function updateBrandAction(id: string, input: unknown) {
  return runAction(async (actor) => ({ id: (await updateBrand(actor, String(id), input)).id }), INVENTORY);
}

export async function setBrandStatusAction(id: string, s: "ACTIVE" | "INACTIVE") {
  return runAction(async (actor) => {
    await setBrandStatus(actor, String(id), status(s));
  }, INVENTORY);
}

export async function linkBrandAction(input: unknown) {
  return runAction(async (actor) => ({ id: (await linkBrand(actor, input)).id }), INVENTORY);
}

export async function unlinkBrandAction(itemBrandId: string) {
  return runAction(async (actor) => {
    await unlinkBrand(actor, String(itemBrandId));
  }, INVENTORY);
}

/** Manual stock change: `input` (JSON) + mandatory `evidence` file in one FormData. */
export async function postStockMovementAction(form: FormData) {
  return runAction(async (actor) => {
    let input: unknown = {};
    try {
      input = JSON.parse(String(form.get("input") ?? "{}"));
    } catch {
      input = {};
    }
    const file = form.get("evidence");
    const evidence = file instanceof File && file.size > 0 ? { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
    const { txn, duplicate } = await postStockMovement(actor, input, evidence);
    return { id: txn.id, code: txn.code, balanceAfter: txn.balanceAfter, duplicate };
  }, INVENTORY);
}
