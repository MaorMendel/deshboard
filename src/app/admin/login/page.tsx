import { loginAction } from "../actions";
import { LoginForm } from "../forms";

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-sm pt-12">
      <h1 className="mb-6 text-2xl font-semibold">כניסה לניהול</h1>
      <LoginForm action={loginAction} />
    </main>
  );
}
