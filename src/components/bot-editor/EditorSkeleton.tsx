function Bar({ className }: { className: string }) {
  return <div className={`rounded-lg bg-line/70 ${className}`} />;
}

export function EditorSkeleton() {
  return (
    <main
      aria-busy="true"
      aria-label="טוען את הגדרות הבוט"
      className="mx-auto w-full max-w-5xl px-4 pt-10 sm:px-6 motion-safe:animate-pulse"
    >
      <div className="border-b border-line pb-6">
        <Bar className="h-8 w-48" />
        <Bar className="mt-3 h-4 w-40" />
      </div>
      <div className="grid gap-12 pt-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
        <div className="flex flex-col gap-6">
          <Bar className="h-6 w-32" />
          <Bar className="h-20 w-full" />
          <Bar className="h-24 w-full" />
          <Bar className="h-24 w-full" />
        </div>
        <div className="flex flex-col gap-2">
          <Bar className="mb-4 h-6 w-32" />
          {Array.from({ length: 5 }, (_, i) => (
            <Bar key={i} className="h-14 w-full" />
          ))}
        </div>
      </div>
    </main>
  );
}
