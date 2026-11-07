import { ArrowLeft, ArrowRight, CircleCheck } from "lucide-react";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import type { SetupState, SetupStep, SetupStepId, SetupStepStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useSetup } from "./context";
import { FailureAlert } from "./notices";
import { STEP_CONTENT } from "./step-bodies";

const STATUS_TEXT: Record<SetupStepStatus, string> = {
  complete: "Complete",
  current: "Current step",
  upcoming: "Upcoming",
};

type Direction = "forward" | "back";

interface View {
  anchor: string;
  step: SetupStepId;
  direction: Direction;
}

// A new current step or a new failure from the server replaces whatever step the user was reviewing.
function anchorOf(state: SetupState): string {
  return `${state.current ?? "done"}:${state.error?.step ?? ""}`;
}

function defaultStep(state: SetupState): SetupStepId {
  return state.error?.step ?? state.current ?? state.steps[state.steps.length - 1]?.id ?? "scan";
}

// Finished and current steps can be revisited, and so can a step carrying a failure the user must read.
function canVisit(step: SetupStep | undefined, state: SetupState): step is SetupStep {
  return step !== undefined && (step.status !== "upcoming" || state.error?.step === step.id);
}

function StepMarker({ status, position, selected }: { status: SetupStepStatus; position: number; selected: boolean }) {
  const ring = selected ? "ring-[3px] ring-ring/30" : null;
  if (status === "complete") {
    return (
      <span aria-hidden="true" className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", ring)}>
        <CircleCheck className="size-6 shrink-0 text-success" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
        status === "current" ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
        ring,
      )}
    >
      {position}
    </span>
  );
}

interface StepItemProps {
  step: SetupStep;
  position: number;
  total: number;
  viewing: boolean;
  onSelect: (id: SetupStepId) => void;
}

function StepItem({ step, position, total, viewing, onSelect }: StepItemProps) {
  const { state } = useSetup();
  const content = STEP_CONTENT[step.id];
  const current = step.status === "current";
  const visitable = canVisit(step, state);
  const description = step.status === "complete" ? content.summary(state) : step.status === "upcoming" ? content.hint : null;
  const label = (
    <>
      <StepMarker status={step.status} position={position} selected={viewing && !current} />
      <span
        className={cn(
          "sr-only text-xs leading-snug text-balance sm:not-sr-only",
          current || viewing ? "font-medium text-foreground" : "text-muted-foreground",
          visitable && "group-hover:text-foreground",
        )}
      >
        {step.title}
      </span>
    </>
  );

  return (
    <li data-step={step.id} aria-current={current ? "step" : undefined} className="relative flex min-w-0 flex-1 flex-col items-center">
      {position < total ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-3 left-[calc(50%+1.25rem)] h-px w-[calc(100%-2.5rem)] transition-colors duration-300",
            step.status === "complete" ? "bg-success" : "bg-border",
          )}
        />
      ) : null}
      {visitable ? (
        <button
          type="button"
          aria-label={`Go to step ${position}: ${step.title}`}
          aria-pressed={viewing}
          onClick={() => onSelect(step.id)}
          className="group flex flex-col items-center gap-1.5 rounded-md px-1 text-center outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {label}
        </button>
      ) : (
        <div className="flex flex-col items-center gap-1.5 px-1 text-center">{label}</div>
      )}
      <span className="sr-only">{STATUS_TEXT[step.status]}</span>
      {description ? <span className="sr-only">{description}</span> : null}
    </li>
  );
}

interface StepPanelProps {
  step: SetupStep;
  position: number;
  total: number;
  direction: Direction;
  previous: SetupStep | undefined;
  next: SetupStep | undefined;
  onSelect: (id: SetupStepId) => void;
}

function StepPanel({ step, position, total, direction, previous, next, onSelect }: StepPanelProps) {
  const { state } = useSetup();
  const headingId = useId();
  const content = STEP_CONTENT[step.id];
  const complete = step.status === "complete";
  const current = step.status === "current";
  const failure = state.error?.step === step.id ? state.error : null;
  const description = complete ? content.summary(state) : step.status === "upcoming" ? content.hint : null;
  const Body = current || failure !== null ? content.Body : undefined;
  const Extra = complete ? content.Complete : undefined;
  const back = canVisit(previous, state) ? previous : null;
  const forward = !current && canVisit(next, state) ? next : null;
  const resume = !current && state.current !== null && state.current !== next?.id && state.current !== previous?.id ? state.current : null;

  return (
    <section
      data-step-panel={step.id}
      data-direction={direction}
      aria-labelledby={headingId}
      className="panel-enter flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-sm"
    >
      <CardHeader>
        <p className="text-xs font-medium text-muted-foreground tabular-nums">
          Step {position} of {total}
        </p>
        <h2
          id={headingId}
          tabIndex={-1}
          className="rounded-sm text-lg leading-tight font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {step.title}
        </h2>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      {failure || Body || Extra ? (
        <CardContent className="flex flex-col gap-4">
          {failure ? <FailureAlert title={content.failureTitle} message={failure.message} /> : null}
          {Body ? <Body /> : null}
          {Extra ? <Extra /> : null}
        </CardContent>
      ) : null}
      {back || forward || resume ? (
        <CardFooter className="gap-2">
          {back ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onSelect(back.id)}>
              <ArrowLeft aria-hidden="true" />
              Back
            </Button>
          ) : null}
          <div className="ml-auto flex flex-wrap justify-end gap-2">
            {resume ? (
              <Button type="button" variant="outline" size="sm" onClick={() => onSelect(resume)}>
                Back to current step
              </Button>
            ) : null}
            {forward ? (
              <Button type="button" size="sm" onClick={() => onSelect(forward.id)}>
                Continue
                <ArrowRight aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </CardFooter>
      ) : null}
    </section>
  );
}

// Moves focus to the new step's heading when setup advances, unless the user is working elsewhere on the page.
function useAdvanceFocus(root: RefObject<HTMLElement | null>, current: SetupStepId | null) {
  const previous = useRef(current);
  useEffect(() => {
    if (previous.current === current) return;
    previous.current = current;
    if (current === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    root.current?.querySelector<HTMLElement>(`[data-step-panel="${current}"] h2`)?.focus();
  }, [root, current]);
}

export function Stepper() {
  const { state } = useSetup();
  const root = useRef<HTMLDivElement>(null);
  const anchor = anchorOf(state);
  const [choice, setChoice] = useState<View | null>(null);
  const [seenAnchor, setSeenAnchor] = useState(anchor);
  const [focusRequest, setFocusRequest] = useState(0);
  // Forget the pick as soon as the anchor moves, so it cannot come back if the anchor later returns to its old value.
  if (seenAnchor !== anchor) {
    setSeenAnchor(anchor);
    setChoice(null);
  }
  const view: View = choice?.anchor === anchor ? choice : { anchor, step: defaultStep(state), direction: "forward" };
  const steps = state.steps;
  const index = Math.max(
    0,
    steps.findIndex((step) => step.id === view.step),
  );
  const step = steps[index];

  useAdvanceFocus(root, state.current);
  useEffect(() => {
    if (focusRequest > 0) root.current?.querySelector<HTMLElement>("[data-step-panel] h2")?.focus();
  }, [focusRequest]);

  const select = (id: SetupStepId) => {
    const target = steps.findIndex((candidate) => candidate.id === id);
    setChoice({ anchor, step: id, direction: target < index ? "back" : "forward" });
    setFocusRequest((count) => count + 1);
  };

  return (
    <div ref={root} className="flex flex-col gap-5">
      <ol aria-label="Setup steps" className="flex items-start">
        {steps.map((item, position) => (
          <StepItem
            key={item.id}
            step={item}
            position={position + 1}
            total={steps.length}
            viewing={item.id === step?.id}
            onSelect={select}
          />
        ))}
      </ol>
      {step ? (
        <StepPanel
          key={step.id}
          step={step}
          position={index + 1}
          total={steps.length}
          direction={view.direction}
          previous={steps[index - 1]}
          next={steps[index + 1]}
          onSelect={select}
        />
      ) : null}
    </div>
  );
}
