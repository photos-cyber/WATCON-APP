"use server";

import { runAction } from "@/lib/actions";
import { setApprovalLimit, updateCommercialSettings, updateSeries } from "./commercial";
import { updateBranding } from "./branding";
import { updateCompany, updateRolePermissions } from "./service";

export async function updateBrandingAction(input: unknown) {
  return runAction(async (actor) => {
    await updateBranding(actor, input);
  }, ["/settings"]);
}

export async function updateCompanyAction(input: unknown) {
  return runAction(async (actor) => {
    await updateCompany(actor, input);
  }, ["/"]);
}

export async function updateRolePermissionsAction(input: unknown) {
  return runAction(async (actor) => {
    await updateRolePermissions(actor, input);
  }, ["/settings"]);
}

export async function updateCommercialSettingsAction(input: unknown) {
  return runAction(async (actor) => {
    await updateCommercialSettings(actor, input);
  }, ["/settings"]);
}

export async function updateSeriesAction(input: unknown) {
  return runAction(async (actor) => {
    await updateSeries(actor, input);
  }, ["/settings"]);
}

export async function setApprovalLimitAction(input: unknown) {
  return runAction(async (actor) => {
    await setApprovalLimit(actor, input);
  }, ["/settings"]);
}
