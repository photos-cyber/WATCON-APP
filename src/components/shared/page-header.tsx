import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export type Crumb = { label: string; href?: string };

export function PageHeader({ title, description, breadcrumbs = [], actions, meta }: { title: ReactNode; description?: ReactNode; breadcrumbs?: Crumb[]; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3">
      {breadcrumbs.length > 0 && (
        <Breadcrumb>
          <BreadcrumbList>
            {breadcrumbs.map((c, i) => (
              <Fragment key={`${c.label}-${i}`}>
                <BreadcrumbItem>
                  {c.href && i < breadcrumbs.length - 1 ? (
                    <BreadcrumbLink asChild>
                      <Link href={c.href}>{c.label}</Link>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{c.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
                {i < breadcrumbs.length - 1 && <BreadcrumbSeparator />}
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      )}
      {/* Title keeps a readable minimum width. Actions sit on the right when they fit; when there
          are many (document pages), the whole group wraps onto its own row under the title and
          wraps internally — it never squeezes the title into a narrow column. */}
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-[1_1_18rem]">
          <h1 className="text-xl font-semibold tracking-tight break-words text-foreground sm:text-2xl">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">{meta}</div>}
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
