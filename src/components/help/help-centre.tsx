"use client";
import { useState } from "react";
import Link from "next/link";
import type { HelpArticle } from "@/modules/help/articles";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function HelpCentre({ articles }: { articles: HelpArticle[] }) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const matches = articles.filter((a) => `${a.title} ${a.category} ${a.summary} ${a.sections.map((s) => `${s.title} ${s.paragraphs.join(" ")}`).join(" ")}`.toLowerCase().includes(term));
  const categories = [...new Set(matches.map((a) => a.category))];
  return <div className="space-y-6">
    <div className="flex flex-wrap gap-2 print:hidden">
      <Button asChild variant="outline"><a href="/api/help/manual?format=pdf">Download User Manual</a></Button>
      <Button asChild variant="outline"><a href="/api/help/manual?format=quick">Quick Start PDF</a></Button>
    </div>
    <label htmlFor="help-search" className="block text-sm font-medium">Search help articles</label>
    <Input id="help-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Try stock, payment or password" className="max-w-xl" />
    <p role="status" className="text-sm text-muted-foreground">{matches.length} articles found</p>
    <nav aria-label="Help topics" className="flex flex-wrap gap-3 text-sm">{categories.map((c) => <a key={c} className="underline" href={`#category-${c.replaceAll(" ", "-")}`}>{c}</a>)}</nav>
    {categories.map((c) => <section key={c} id={`category-${c.replaceAll(" ", "-")}`} className="scroll-mt-6 space-y-3">
      <h2 className="text-lg font-semibold">{c}</h2>
      {matches.filter((a) => a.category === c).map((a) => <article key={a.id} id={a.id} className="scroll-mt-6 rounded-lg border bg-card p-4 sm:p-6">
        <h3 className="text-base font-semibold">{a.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{a.summary}</p>
        {a.route && <Link href={a.route} className="mt-2 inline-block text-sm text-primary underline">Open {a.title}</Link>}
        <details className="mt-3" open={term.length > 0 || undefined}>
          <summary className="cursor-pointer text-sm font-medium">Read step-by-step guide</summary>
          <div className="mt-4 space-y-4">{a.sections.map((s) => <section key={s.title}><h4 className="text-sm font-semibold">{s.title}</h4>{s.paragraphs.map((p, i) => <p key={i} className="mt-1 text-sm leading-relaxed break-words">{p}</p>)}</section>)}</div>
        </details>
      </article>)}
    </section>)}
    {!matches.length && <p>No matching help. Try a shorter word, such as stock or invoice.</p>}
  </div>;
}
