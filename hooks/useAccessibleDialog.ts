"use client";

import { useLayoutEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTabFocus(event: KeyboardEvent, dialog: HTMLDivElement): void {
  const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const focusIsOutside = !dialog.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || focusIsOutside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || focusIsOutside)) {
    event.preventDefault();
    first.focus();
  }
}

export function useAccessibleDialog(isOpen: boolean, onClose: () => void, canClose = true) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  onCloseRef.current = onClose;
  canCloseRef.current = canClose;

  useLayoutEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initialFocus =
      dialog?.querySelector<HTMLElement>("[data-dialog-initial-focus]:not([disabled])") ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (initialFocus ?? dialog)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && canCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      trapTabFocus(event, dialogRef.current);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || !dialogRef.current) return;
    const activeElement = document.activeElement;
    const activeElementIsDisabled = activeElement instanceof HTMLElement && activeElement.hasAttribute("disabled");
    if (!canClose && activeElementIsDisabled) {
      const nextFocus = dialogRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      activeElement.blur();
      (nextFocus ?? dialogRef.current).focus();
    }
  }, [canClose, isOpen]);

  return dialogRef;
}
