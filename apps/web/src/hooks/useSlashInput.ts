import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { isEnterSubmit } from "../shortcuts";
import { matchSlashSuggestions } from "../slashCommands";
import type { SlashCommand } from "../slashCommands";

interface UseSlashInputOptions {
  value: string;
  onChange: (next: string) => void;
  onRunCommand: (commandText: string) => void;
  onFocusInput: () => void;
  history?: readonly string[];
}

export function useSlashInput({
  value,
  onChange,
  onRunCommand,
  onFocusInput,
  history = [],
}: UseSlashInputOptions) {
  const [slashIndex, setSlashIndex] = useState(0);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);

  const slashMatches = useMemo(() => matchSlashSuggestions(value), [value]);
  const activeSlashIndex = slashMatches.length ? Math.min(slashIndex, slashMatches.length - 1) : 0;

  function applySlashCommand(command: SlashCommand) {
    if (command.takesArg) {
      onChange(`/${command.name} `);
      setSlashIndex(0);
      requestAnimationFrame(onFocusInput);
    } else {
      onRunCommand(`/${command.name}`);
      onChange("");
      setSlashIndex(0);
    }
  }

  function handleChange(next: string) {
    setHistoryCursor(null);
    setSlashIndex(0);
    onChange(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((current) => (current + 1) % slashMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((current) => (current - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        applySlashCommand(slashMatches[activeSlashIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onChange("");
        setSlashIndex(0);
        return;
      }
    }

    if (event.key === "ArrowUp" && !value.trim() && history.length > 0 && !event.shiftKey) {
      event.preventDefault();
      const nextIndex = historyCursor === null ? history.length - 1 : Math.max(0, historyCursor - 1);
      setHistoryCursor(nextIndex);
      onChange(history[nextIndex]);
      return;
    }

    if (event.key === "ArrowDown" && historyCursor !== null && !event.shiftKey) {
      event.preventDefault();
      if (historyCursor + 1 >= history.length) {
        setHistoryCursor(null);
        onChange("");
      } else {
        const nextIndex = historyCursor + 1;
        setHistoryCursor(nextIndex);
        onChange(history[nextIndex]);
      }
      return;
    }

    if (isEnterSubmit(event)) {
      event.preventDefault();
      if (slashMatches.length > 0 && !value.includes(" ")) {
        applySlashCommand(slashMatches[activeSlashIndex]);
        return;
      }
      setHistoryCursor(null);
      event.currentTarget.form?.requestSubmit();
    }
  }

  function resetHistory() {
    setHistoryCursor(null);
  }

  return {
    slashMatches,
    activeSlashIndex,
    applySlashCommand,
    handleChange,
    handleKeyDown,
    resetHistory,
  };
}
