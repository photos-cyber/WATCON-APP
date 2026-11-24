import content from "./content.json";
import { can, canAny, type Actor, type PermissionKey } from "@/lib/permissions/definitions";

export type HelpArticle = {
  id: string; title: string; category: string; summary: string;
  sections: { title: string; paragraphs: string[] }[];
  permission: string | null; route: string | null;
};
export const HELP_ARTICLES: HelpArticle[] = content;
export function helpForActor(actor: Actor): HelpArticle[] {
  return HELP_ARTICLES.filter((a) => (a.id === "notes" ? canAny(actor, "bills.view", "invoice.view") : !a.permission || can(actor, a.permission as PermissionKey)) &&
    (a.id !== "administration" || actor.role === "SUPER_ADMIN") &&
    (!a.id.startsWith("role-") || actor.role === "SUPER_ADMIN" || a.id === `role-${actor.role.toLowerCase()}` || a.id === `role-${actor.role.toLowerCase()}-sales`));
}
