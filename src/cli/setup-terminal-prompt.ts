import { createInterface, type Interface } from "node:readline";

/**
 * The questions `setup fusion` asks on a terminal (which orchestrator,
 * apply or not), read from ONE line reader: a second reader over the
 * same stream would lose a line the first had already buffered. Lines
 * typed ahead are queued, so piped answers into a TTY-like stream still
 * land on the questions in order. Not a terminal: nothing is asked and
 * each question answers `"no-tty"`. End of input answers `null`.
 */
export interface SetupTerminal {
  readonly input: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly output: NodeJS.WritableStream;
}

export interface SetupPrompter {
  /** Whether a person can answer (the input is a TTY). */
  readonly isTerminal: boolean;
  ask(question: string): Promise<string | null | "no-tty">;
  close(): void;
}

export function createSetupPrompter(
  terminal: SetupTerminal = { input: process.stdin, output: process.stdout },
): SetupPrompter {
  let rl: Interface | null = null;
  let ended = false;
  const lines: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  const open = (): Interface => {
    if (rl) return rl;
    rl = createInterface({ input: terminal.input, terminal: false });
    rl.on("line", (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    });
    rl.on("close", () => {
      ended = true;
      for (const w of waiting.splice(0)) w(null);
    });
    return rl;
  };
  return {
    isTerminal: terminal.input.isTTY === true,
    async ask(question) {
      if (!terminal.input.isTTY) return "no-tty";
      open();
      terminal.output.write(question);
      const queued = lines.shift();
      if (queued !== undefined) return queued;
      if (ended) return null;
      return new Promise<string | null>((resolve) => waiting.push(resolve));
    },
    close() {
      rl?.close();
      rl = null;
    },
  };
}
