import { Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useSetup } from "./context";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setResult("copied");
    } catch {
      // Sandboxed hosts can deny clipboard access; the text stays selectable beside the button.
      setResult("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult("idle"), 2_000);
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
      {result === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span aria-live="polite">{result === "copied" ? "Copied" : result === "failed" ? "Copy failed" : label}</span>
    </Button>
  );
}

interface ExternalLinkButtonProps {
  url: string;
  children: ReactNode;
  variant?: ComponentProps<typeof Button>["variant"];
  size?: ComponentProps<typeof Button>["size"];
}

// A real anchor in the browser; inside a chat host the host decides whether the link may open.
export function ExternalLinkButton({ url, children, variant = "default", size }: ExternalLinkButtonProps) {
  const { transport } = useSetup();
  const [blocked, setBlocked] = useState(false);

  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!transport.openExternal) return;
    event.preventDefault();
    void transport.openExternal(url).then((opened) => setBlocked(!opened));
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <Button asChild variant={variant} size={size}>
        <a href={url} target="_blank" rel="noopener noreferrer" onClick={open}>
          {children}
          <ExternalLink aria-hidden="true" />{" "}
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </Button>
      {blocked ? (
        <div role="alert" className="flex w-full flex-col items-start gap-2 rounded-md border bg-muted p-3 text-sm">
          <p>This host did not open the link. Copy the address into your browser instead.</p>
          <code className="break-all">{url}</code>
          <CopyButton value={url} label="Copy link" />
        </div>
      ) : null}
    </div>
  );
}
