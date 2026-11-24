"use client";

import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type ComboOption = { value: string; label: string; hint?: string; disabled?: boolean };

/** Searchable multi-select (chips). */
export function MultiSelect({ options, value, onChange, placeholder = "Select…", searchPlaceholder = "Search…", emptyText = "No matches.", id, invalid, disabled }: { options: ComboOption[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string; searchPlaceholder?: string; emptyText?: string; id?: string; invalid?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const selected = value.map((v) => options.find((o) => o.value === v) ?? { value: v, label: "Unknown" });
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-invalid={invalid || undefined} disabled={disabled} className="h-9 w-full justify-between bg-card font-normal">
            <span className={cn("truncate", !value.length && "text-muted-foreground")}>{value.length ? `${value.length} selected` : placeholder}</span>
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0" align="start">
          <Command filter={(itemValue, search) => (itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem key={o.value} value={`${o.label} ${o.hint ?? ""} ${o.value}`} disabled={o.disabled && !value.includes(o.value)} onSelect={() => toggle(o.value)}>
                    <Check className={cn("size-4", value.includes(o.value) ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{o.label}</span>
                    {o.hint && <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{o.hint}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((s) => (
            <span key={s.value} className="inline-flex items-center gap-1 rounded-md border bg-muted/60 py-0.5 pr-1 pl-2 text-xs">
              {s.label}
              <button type="button" disabled={disabled} onClick={() => toggle(s.value)} className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground" aria-label={`Remove ${s.label}`}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Searchable single-select. With `onCreate`, typing a value that has no case-insensitive
 * exact match offers "Add …" (the server still enforces uniqueness).
 */
export function SingleSelect({ options, value, onChange, placeholder = "Select…", searchPlaceholder = "Search…", emptyText = "No matches.", id, ariaLabel, invalid, disabled, allowClear = true, onCreate, createLabel = "Add" }: { options: ComboOption[]; value: string | null; onChange: (v: string | null) => void; placeholder?: string; searchPlaceholder?: string; emptyText?: string; id?: string; ariaLabel?: string; invalid?: boolean; disabled?: boolean; allowClear?: boolean; onCreate?: (text: string) => void; createLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const current = options.find((o) => o.value === value);
  const typed = search.trim();
  const exact = typed && options.some((o) => o.label.trim().toLowerCase() === typed.toLowerCase());
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} type="button" variant="outline" role="combobox" aria-label={ariaLabel} aria-expanded={open} aria-invalid={invalid || undefined} disabled={disabled} className="h-9 w-full justify-between bg-card font-normal">
          <span className={cn("truncate", !current && "text-muted-foreground")}>{current ? current.label : placeholder}</span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0" align="start">
        <Command filter={(itemValue, search) => (itemValue.startsWith("__create__") ? 1 : itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}>
          <CommandInput placeholder={searchPlaceholder} value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {onCreate && typed && !exact && (
                <CommandItem value={`__create__ ${typed}`} onSelect={() => { onCreate(typed); setSearch(""); setOpen(false); }}>
                  <Plus className="size-4" />
                  <span className="truncate">
                    {createLabel} “{typed}”
                  </span>
                </CommandItem>
              )}
              {allowClear && value && (
                <CommandItem value="__clear__ none" onSelect={() => { onChange(null); setOpen(false); }}>
                  <X className="size-4 opacity-60" />
                  <span className="text-muted-foreground">Clear selection</span>
                </CommandItem>
              )}
              {options.map((o) => (
                <CommandItem key={o.value} value={`${o.label} ${o.hint ?? ""} ${o.value}`} disabled={o.disabled} onSelect={() => { onChange(o.value); setOpen(false); }}>
                  <Check className={cn("size-4", value === o.value ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{o.label}</span>
                  {o.hint && <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{o.hint}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export type PersonOption = { id: string; fullName: string; employeeCode: string; designation: string | null; departmentIds?: string[] };
export type DepartmentOption = { id: string; name: string; code: string; status?: string };
export type ProjectOption = { id: string; name: string; code: string };

export const personOptions = (people: PersonOption[]): ComboOption[] => people.map((p) => ({ value: p.id, label: p.fullName, hint: [p.employeeCode, p.designation].filter(Boolean).join(" · ") }));
export const departmentOptions = (deps: DepartmentOption[]): ComboOption[] => deps.map((d) => ({ value: d.id, label: d.name, hint: d.status === "INACTIVE" ? "Inactive" : d.code, disabled: d.status === "INACTIVE" }));
export const projectOptions = (projects: ProjectOption[]): ComboOption[] => projects.map((p) => ({ value: p.id, label: p.name, hint: p.code }));

export function UserMultiSelect(props: { people: PersonOption[]; value: string[]; onChange: (v: string[]) => void; id?: string; invalid?: boolean }) {
  return <MultiSelect id={props.id} invalid={props.invalid} options={personOptions(props.people)} value={props.value} onChange={props.onChange} placeholder="Select team members" searchPlaceholder="Search people…" />;
}

export function DepartmentMultiSelect(props: { departments: DepartmentOption[]; value: string[]; onChange: (v: string[]) => void; id?: string; invalid?: boolean }) {
  return <MultiSelect id={props.id} invalid={props.invalid} options={departmentOptions(props.departments)} value={props.value} onChange={props.onChange} placeholder="Select departments" searchPlaceholder="Search departments…" />;
}

export function ProjectSelect(props: { projects: ProjectOption[]; value: string | null; onChange: (v: string | null) => void; id?: string; invalid?: boolean; disabled?: boolean }) {
  return <SingleSelect id={props.id} invalid={props.invalid} disabled={props.disabled} allowClear={false} options={projectOptions(props.projects)} value={props.value} onChange={props.onChange} placeholder="Select a project" searchPlaceholder="Search projects…" />;
}
