import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/setup/error-boundary";

function Broken(): never {
  throw new Error("render exploded");
}

function quietConsole() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("ErrorBoundary", () => {
  it("renders its children while nothing is wrong", () => {
    render(
      <ErrorBoundary>
        <p>Setup is running</p>
      </ErrorBoundary>,
    );

    expect(screen.getByText("Setup is running")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("replaces a view that fails to render with an explanation of what to do", () => {
    quietConsole();

    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The setup view hit an error");
    expect(alert).toHaveTextContent("Reload this view. The setup server keeps your progress, so restart setup only if the problem continues.");
  });

  it("leaves a trace in the console so the cause can be found", () => {
    const log = quietConsole();

    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );

    expect(log).toHaveBeenCalledWith("The setup view failed to render.", expect.objectContaining({ message: "render exploded" }));
  });

  it("keeps the explanation rather than rendering a view that already failed once", () => {
    quietConsole();
    const { rerender } = render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );

    rerender(
      <ErrorBoundary>
        <p>Setup is running</p>
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The setup view hit an error");
    expect(screen.queryByText("Setup is running")).not.toBeInTheDocument();
  });
});
