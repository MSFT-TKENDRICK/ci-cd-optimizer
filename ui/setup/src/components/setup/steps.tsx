import { CircleCheck } from "lucide-react";
import { useEffect, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import type { SetupStep, SetupStepId, SetupStepStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useSetup } from "./context";
import { FailureAlert } from "./notices";
import { STEP_CONTENT } from "./step-bodies";

const STATUS_TEXT: Record<SetupStepStatus, string> = {
  complete: "Complete",
  current: "Current step",
  upcoming: "Upcoming",
};

function StepMarker({ status, position }: { status: SetupStepStatus; position: number }) {
  if (status === "complete") return <CircleCheck className="size-6 shrink-0 text-success" aria-hidden="true" />;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
        status === "current" ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
      )}
    >
      {position}
    </span>
  );
}

function StepCard({ step, position }: { step: SetupStep; position: number }) {
  const { state } = useSetup();
  const content = STEP_CONTENT[step.id];
  const failure = state.error?.step === step.id ? state.error : null;
  const current = step.status === "current";
  const complete = step.status === "complete";
  const Body = content.Body;
  const Extra = complete ? content.Complete : undefined;
  const description = complete ? content.summary(state) : step.status === "upcoming" ? content.hint : null;
  const showBody = current || failure !== null;

  return (
    <li data-step={step.id} aria-current={current ? "step" : undefined}>
      <Card className={cn("gap-3 py-4", current && "gap-4 border-primary/60 py-5")}>
        <CardHeader className="gap-1">
          <div className="flex items-center gap-3">
            <StepMarker status={step.status} position={position} />
            <h2
              tabIndex={-1}
              className={cn(
                "rounded-sm text-base leading-none font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                step.status === "upcoming" && "text-muted-foreground",
              )}
            >
              {step.title}
            </h2>
            <span className="sr-only">{STATUS_TEXT[step.status]}</span>
          </div>
          {description ? <CardDescription className="pl-9">{description}</CardDescription> : null}
        </CardHeader>
        {failure || showBody || Extra ? (
          <CardContent className="flex flex-col gap-4">
            {failure ? <FailureAlert title={content.failureTitle} message={failure.message} /> : null}
            {showBody ? <Body /> : null}
            {Extra ? <Extra /> : null}
          </CardContent>
        ) : null}
      </Card>
    </li>
  );
}

// Moves focus to the next step only when the user's focus was lost, so it never steals it from a control in use.
function useAdvanceFocus(current: SetupStepId | null) {
  const list = useRef<HTMLOListElement>(null);
  const previous = useRef(current);
  useEffect(() => {
    if (previous.current === current) return;
    previous.current = current;
    if (!current) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    list.current?.querySelector<HTMLElement>(`[data-step="${current}"] h2`)?.focus();
  }, [current]);
  return list;
}

export function Stepper() {
  const { state } = useSetup();
  const list = useAdvanceFocus(state.current);
  return (
    <ol ref={list} aria-label="Setup steps" className="flex flex-col gap-3">
      {state.steps.map((step, index) => (
        <StepCard key={step.id} step={step} position={index + 1} />
      ))}
    </ol>
  );
}
