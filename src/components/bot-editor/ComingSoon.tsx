export function ComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium text-ink">{title}</h3>
        <span className="rounded-full bg-caller px-2.5 text-xs leading-6 text-ink-soft">בפיתוח</span>
      </div>
      <p className="mt-1.5 text-sm text-ink-soft">{description}</p>
    </div>
  );
}
