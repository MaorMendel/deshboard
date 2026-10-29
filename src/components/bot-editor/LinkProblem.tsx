export function LinkProblem({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-16 sm:px-6">
      <h1 className="text-[28px] font-semibold leading-tight">{title}</h1>
      <p className="mt-3 text-lg leading-relaxed text-ink-soft">{body}</p>
    </main>
  );
}
