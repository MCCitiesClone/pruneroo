"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy the ready-made `/prune <username> <amount>` command.
 *
 * The command is built server-side and passed in, so the button and the title
 * text can never disagree about what lands on the clipboard.
 */
export function CopyCommand({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Clearing on unmount avoids setting state on a row that has been filtered
  // away while the confirmation was still showing.
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    try {
      // Only available in a secure context; on plain http over a LAN it is
      // undefined, so fall back rather than throwing an opaque error.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command);
      } else {
        const area = document.createElement("textarea");
        area.value = command;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        if (!ok) throw new Error("copy rejected");
      }
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  }, [command]);

  return (
    <button
      type="button"
      onClick={copy}
      // The full command, so it can be read (or typed out) without copying.
      title={command}
      aria-label={`Copy command: ${command}`}
      className="rounded border border-border-subtle px-2 py-1 font-mono text-xs whitespace-nowrap transition-colors hover:bg-surface-muted"
    >
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed"
          : "Copy /prune"}
    </button>
  );
}
