import { Skeleton } from "@/components/ui/skeleton";

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}
