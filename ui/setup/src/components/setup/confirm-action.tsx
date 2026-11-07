import { LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import type { ActionPayload, SetupAction } from "@/lib/types";
import { useSetup } from "./context";

type ButtonLook = Pick<ComponentProps<typeof Button>, "variant" | "size">;

// The trigger is disabled while an action runs, so focus falls to the page. Put it back once the action
// settles, using the panel heading when the trigger itself stays disabled.
function useRestoreFocus(running: boolean, trigger: RefObject<HTMLButtonElement | null>) {
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running && document.activeElement === document.body) {
      const button = trigger.current;
      const target = button && !button.disabled ? button : button?.closest("[data-step-panel]")?.querySelector<HTMLElement>("h2");
      target?.focus({ preventScroll: true });
    }
    wasRunning.current = running;
  }, [running, trigger]);
}

interface ConfirmActionProps extends ButtonLook {
  action: SetupAction;
  label: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  // Read when the user confirms, so a secret never sits in a prop or the confirmation.
  payload?: () => ActionPayload;
  onDone?: (ok: boolean) => void;
  disabled?: boolean;
  // Controlled by a form that shows the confirmation on submit.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface ConfirmationProps {
  id: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// Part of the page, right after the button that asked for it, rather than a modal. A View is sized to its content
// inside a frame the host owns, so it cannot know which part of the page the user is looking at, and a modal
// centred on the viewport can land out of sight. The MCP Apps spec offers no host modal to use instead.
function Confirmation({ id, title, description, confirmLabel, onConfirm, onCancel }: ConfirmationProps) {
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  // Cancel is the safe default. Scroll first, so that focusing it does not have to.
  useEffect(() => {
    panel.current?.scrollIntoView({ block: "nearest" });
    cancel.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={panel}
      id={id}
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
      className="flex w-full flex-col gap-3 rounded-md bg-muted p-4"
    >
      <p id={`${id}-title`} className="font-medium">
        {title}
      </p>
      <p id={`${id}-description`} className="text-sm text-muted-foreground">
        {description}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button ref={cancel} type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

// Every mutating action goes through an explicit confirmation naming its consequence.
export function ConfirmAction({ action, label, title, description, confirmLabel, payload, onDone, disabled = false, open, onOpenChange, variant = "default", size }: ConfirmActionProps) {
  const { act, pending, locked, state } = useSetup();
  const trigger = useRef<HTMLButtonElement>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const panelId = useId();
  const running = pending === action;
  const blocked = disabled || locked || state.busy || pending !== null;
  const isOpen = open ?? internalOpen;
  const showing = isOpen && !blocked;
  useRestoreFocus(running, trigger);

  const change = (next: boolean) => {
    if (open === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };

  // A confirmation belongs to the moment it was asked. When the action stops being available, drop it rather
  // than let it reappear, out of date, once the page unblocks.
  useEffect(() => {
    if (isOpen && blocked) change(false);
  }, [isOpen, blocked]);

  const cancel = () => {
    change(false);
    trigger.current?.focus();
  };

  const confirm = async () => {
    change(false);
    const ok = await act(action, payload?.());
    onDone?.(ok);
  };

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant={variant}
        size={size}
        disabled={blocked}
        aria-expanded={showing}
        aria-controls={showing ? panelId : undefined}
        onClick={() => {
          if (!isOpen) change(true);
        }}
      >
        {running ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
        {label}
      </Button>
      {showing ? (
        <Confirmation id={panelId} title={title} description={description} confirmLabel={confirmLabel} onConfirm={() => void confirm()} onCancel={cancel} />
      ) : null}
    </>
  );
}

interface ActionButtonProps extends ButtonLook {
  action: SetupAction;
  children: ReactNode;
  disabled?: boolean;
}

// For actions that only read state, so they need no confirmation.
export function ActionButton({ action, children, disabled = false, variant = "outline", size }: ActionButtonProps) {
  const { act, pending, locked, state } = useSetup();
  const button = useRef<HTMLButtonElement>(null);
  const running = pending === action;
  useRestoreFocus(running, button);

  return (
    <Button ref={button} type="button" variant={variant} size={size} disabled={disabled || locked || state.busy || pending !== null} onClick={() => void act(action)}>
      {running ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}
