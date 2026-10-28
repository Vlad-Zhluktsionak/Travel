"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

interface Props {
  children: React.ReactNode;
  /** Shown with a spinner while the form's server action runs, e.g. "Checking price…". */
  pending: string;
  /** Shown briefly after it finishes, e.g. "✓ Checked". Omit for actions that leave the page. */
  done?: string;
  className?: string;
  /** Ask before submitting (for destructive actions). */
  confirm?: string;
}

/**
 * Submit button with feedback: disabled with a spinner while the action runs (so it can't be
 * double-clicked and the page never looks frozen), then a short "done" message.
 */
export function SubmitButton({ children, pending: pendingLabel, done, className, confirm }: Props) {
  const { pending } = useFormStatus();
  const [showDone, setShowDone] = useState(false);
  const wasPending = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (pending) {
      wasPending.current = true;
      setShowDone(false);
      return;
    }
    if (wasPending.current && done) {
      wasPending.current = false;
      setShowDone(true);
      // Kept in a ref (not effect cleanup): the page re-renders with fresh data right after an action,
      // and that must not cancel the reset.
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setShowDone(false), 2500);
    }
  }, [pending, done]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="submit"
      className={[className, showDone ? "is-done" : ""].filter(Boolean).join(" ") || undefined}
      disabled={pending}
      aria-busy={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? (
        <>
          <span className="spinner" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : showDone ? (
        done
      ) : (
        children
      )}
    </button>
  );
}
