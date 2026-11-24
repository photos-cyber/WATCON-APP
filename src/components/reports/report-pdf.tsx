import { Document, Page } from "@react-pdf/renderer";
import { ContinuationHeader, DocumentFooter, Note, ReportHeader, ReportTable } from "@/components/documents/pdf/components";
import { registerPdfFonts, S } from "@/components/documents/pdf/theme";
import type { PdfColumn, PdfOrg } from "@/components/documents/pdf/types";
import { PRIORITY_LABELS, TASK_STATUS_LABELS, formatDate, formatDateTime } from "@/lib/format";
import type { ReportData } from "@/modules/reports/service";

const COLS: PdfColumn[] = [
  { key: "code", label: "Code", width: 9 },
  { key: "task", label: "Task", width: 31 },
  { key: "members", label: "Assigned members", width: 16 },
  { key: "depts", label: "Departments", width: 13 },
  { key: "priority", label: "Priority", width: 8 },
  { key: "status", label: "Status", width: 9 },
  { key: "due", label: "Due", width: 8 },
  { key: "progress", label: "Progress", width: 6, align: "right" },
];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Task report (project / member / department / all) on the shared WATCON report layout:
 * A4 landscape, letterhead, repeating table header, rows never split, Page X of Y.
 */
export function ReportPdf({ report, org }: { report: ReportData; org: PdfOrg }) {
  registerPdfFonts();
  const open = report.tasks.filter((t) => t.status !== "COMPLETED" && t.status !== "CANCELLED").length;
  const done = report.tasks.filter((t) => t.status === "COMPLETED").length;
  const legal = org.legalName || org.name;
  return (
    <Document title={`${report.title} — ${report.subject}`} author={legal} creator={`${org.name} ERP`}>
      <Page size="A4" orientation="landscape" style={S.page}>
        <ContinuationHeader left={legal} right={`${report.title} — ${report.subject}`} />
        <ReportHeader
          org={org}
          title={report.title}
          subject={report.subject}
          generated={`Generated ${formatDateTime(report.generatedAt)} by ${report.generatedBy}`}
          details={[...report.details.map((d) => ({ label: d.label, value: d.value })), { label: "Tasks", value: `${report.tasks.length}  ·  open ${open}  ·  completed ${done}`, strong: true }]}
        />
        <ReportTable
          columns={COLS}
          emptyText="No tasks."
          rows={report.tasks.map((t) => ({
            code: t.code,
            task: { text: t.title, sub: [report.type !== "project" ? t.project.name : null, t.description ? clip(t.description, 600) : null].filter(Boolean).join(" — ") || null },
            members: t.assignees.map((a) => a.user.fullName).join(", ") || "—",
            depts: t.departments.map((d) => d.department.name).join(", ") || "—",
            priority: PRIORITY_LABELS[t.priority],
            status: TASK_STATUS_LABELS[t.status],
            due: formatDate(t.dueDate),
            progress: `${t.progress}%`,
          }))}
        />
        {report.truncated ? <Note>Only the first {report.tasks.length} tasks are included.</Note> : null}
        <DocumentFooter left={`${legal}  ·  ${report.title}  ·  ${report.subject}`} note={org.footer} />
      </Page>
    </Document>
  );
}
