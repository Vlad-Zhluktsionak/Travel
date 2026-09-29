"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { addFromPastedEmail, requestLogin, type FormState } from "./actions";

function Submit({ children, pending: pendingLabel }: { children: React.ReactNode; pending: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}

export function LoginForm() {
  const [state, action] = useActionState<FormState, FormData>(requestLogin, {});
  return (
    <form action={action} className="stack login">
      <input type="email" name="email" placeholder="you@example.com" required autoComplete="email" />
      <Submit pending="Sending…">Email me a sign-in link</Submit>
      {state.message && <div className={`notice ${state.ok ? "good" : "warn"}`}>{state.message}</div>}
      {state.devLink && (
        <div className="notice warn small">
          Dev mode (no email provider configured): <a href={state.devLink}>sign in now</a>
        </div>
      )}
    </form>
  );
}

export function PasteForm() {
  const [state, action] = useActionState<FormState, FormData>(addFromPastedEmail, {});
  return (
    <form action={action} className="stack">
      <textarea name="email" placeholder="Paste the full airline confirmation email here…" required />
      <Submit pending="Reading with AI…">Track this flight</Submit>
      {state.message && <div className={`notice ${state.ok ? "good" : "warn"}`}>{state.message}</div>}
    </form>
  );
}
