"use client";

import { useActionState } from "react";
import { addFromPastedEmail, requestLogin, type FormState } from "./actions";
import { SubmitButton } from "./submit-button";

export function LoginForm() {
  const [state, action] = useActionState<FormState, FormData>(requestLogin, {});
  return (
    <form action={action} className="stack login">
      <input type="email" name="email" placeholder="you@example.com" required autoComplete="email" />
      <SubmitButton pending="Sending…">Email me a sign-in link</SubmitButton>
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
      <textarea name="email" placeholder="Paste the full flight or hotel confirmation email here…" required />
      <SubmitButton pending="Reading the email with AI… (up to a minute)">Track this trip</SubmitButton>
      {state.message && <div className={`notice ${state.ok ? "good" : "warn"}`}>{state.message}</div>}
    </form>
  );
}
