import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { helpForActor } from "@/modules/help/articles";
import { HelpCentre } from "@/components/help/help-centre";
import { PageHeader } from "@/components/shared/page-header";

export const metadata: Metadata = { title: "Help & User Guide" };
export default async function HelpPage() {
  const actor = await requireUser();
  return <><PageHeader title="Help & User Guide" description="Simple steps for your everyday work. Your permissions decide which actions are available." /><HelpCentre articles={helpForActor(actor)} /></>;
}
