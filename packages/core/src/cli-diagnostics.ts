const CAPTURE_CHARS = 8 * 1024;

const cliFlags = [
  "--agent", "--ask-for-approval", "--disable", "--disable-slash-commands", "--disallowedTools",
  "--effort", "--ephemeral", "--format", "--ignore-rules", "--ignore-user-config", "--include-partial-messages",
  "--input-format", "--json", "--max-tool-calls", "--mcp-config", "--model",
  "--no-chrome", "--no-session-persistence", "--output-format", "--pure", "--safe-mode",
  "--sandbox", "--setting-sources", "--settings", "--skip-git-repo-check",
  "--strict-mcp-config", "--thinking", "--tools", "--variant", "--verbose",
];

const diagnoses = [
  {
    kind: "authentication",
    patterns: [
      /\b(?:401\s+(?:unauthorized|authentication)|(?:http|status(?: code)?|api error)[:= ]+401)\b/i,
      /\b(?:invalid[_ -](?:api[_ -]key|credentials)|authentication(?: is)?[_ -](?:failed|required|error))\b/i,
      /\b(?:could not find|missing|no) (?:an? )?(?:api[_ -]key|authentication credentials)\b/i,
      /\b(?:not (?:logged|signed) in|(?:log|sign) in to (?:continue|use))\b/i,
      /\b(?:(?:expired|missing|invalid) (?:access |refresh )?token|(?:access |refresh )?token (?:has )?expired)\b/i,
    ],
    message: "The CLI could not authenticate. Check its sign-in in Terminal and retry.",
  },
  {
    kind: "quota",
    patterns: [
      /\b(?:insufficient[_ -]quota|(?:usage|billing|credit) (?:limit|quota) (?:reached|exceeded))\b/i,
      /\b(?:quota|credits?) (?:has been |have been )?(?:exceeded|exhausted)\b/i,
      /\b(?:exceeded|exhausted) (?:your |the )?(?:current )?(?:quota|credits?)\b/i,
    ],
    message: "The provider reported an exhausted quota. Check its account limits or select another provider.",
  },
  {
    kind: "rate-limit",
    patterns: [
      /\b(?:(?:http|status(?: code)?|api error)[:= ]+429|too many requests)\b/i,
      /\brate[_ -]limit(?:ed|[_ -](?:exceeded|error|reached))\b/i,
    ],
    message: "The provider rate-limited the run. Wait before retrying or select another provider.",
  },
  {
    kind: "permission",
    patterns: [
      /\b(?:403\s+forbidden|(?:http|status(?: code)?|api error)[:= ]+403)\b/i,
      /\b(?:permission denied|operation not permitted|access denied|EACCES|EPERM)\b/i,
    ],
    message: "The CLI was denied access to a required resource. Check provider access and local permissions in Terminal.",
  },
  {
    kind: "model-unavailable",
    patterns: [
      /\b(?:model[_ -]not[_ -]found|invalid[_ -]model)\b/i,
      /\bmodel\b[^\r\n]{0,140}\b(?:does not exist|is not available|is unavailable|is not supported|was not found)\b/i,
    ],
    message: "The CLI could not use the selected model. Check model availability or choose another model.",
  },
  {
    kind: "context-limit",
    patterns: [
      /\b(?:context[_ -]length[_ -]exceeded|(?:prompt|input) (?:is )?too (?:long|large))\b/i,
      /\bexceeds (?:the )?(?:maximum )?context (?:length|window)\b/i,
    ],
    message: "The prompt exceeded the model’s context limit. Shorten the input or remove attachments from the run.",
  },
  {
    kind: "network",
    patterns: [
      /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN)\b/i,
      /\b(?:network is unreachable|connection (?:failed|lost|refused|reset|timed out))\b/i,
      /\b(?:could not resolve host|unable to (?:connect|resolve)|certificate (?:verification|verify) failed|fetch failed)\b/i,
    ],
    message: "The CLI could not reach its provider. Check the connection or the CLI’s network settings and retry.",
  },
] as const;

type DiagnosticKind = typeof diagnoses[number]["kind"] | "unsupported-option";

export interface CliDiagnostic {
  kind: DiagnosticKind;
  message: string;
}

function classify(text: string, args: readonly string[]): CliDiagnostic | undefined {
  const plain = text.replace(/\u001b\[[\d;]*m/g, "");
  const option = /\b(?:unknown|unexpected|unrecognized|unsupported|invalid) (?:options?|arguments?|flags?)[ \t]*:?[ \t]*[`'"“‘]?(--?[\w][\w-]*|[\w][\w-]*)(?=[\s`'"”’=:,]|$)/i.exec(plain)?.[1];
  if (option) {
    const flag = cliFlags.find((flag) => (option === flag || option === flag.slice(2)) && args.includes(flag));
    return {
      kind: "unsupported-option",
      message: flag
        ? `The CLI rejected ${flag}. Update the CLI to a compatible version or run it in Terminal.`
        : "The CLI rejected an argument. Check its version and arguments in Terminal.",
    };
  }
  const diagnostic = diagnoses.find(({ patterns }) => patterns.some((pattern) => pattern.test(plain)));
  return diagnostic && { kind: diagnostic.kind, message: diagnostic.message };
}

export function classifyCliDiagnostic(text: string, args: readonly string[] = []): CliDiagnostic | undefined {
  if (text.length <= 2 * CAPTURE_CHARS) return classify(text, args);
  return classify(text.slice(0, CAPTURE_CHARS), args) ?? classify(text.slice(-CAPTURE_CHARS), args);
}

// Start draining as soon as the process spawns so a full stderr pipe cannot block stdout.
// Inspect only bounded start and end windows and return fixed text from the classifier.
export async function drainCliDiagnostics(
  stream: AsyncIterable<Uint8Array | string> | null,
  args: readonly string[] = [],
): Promise<CliDiagnostic | undefined> {
  if (!stream) return;
  const decoder = new TextDecoder();
  let head = "";
  let tail = "";
  let truncated = false;

  function capture(text: string) {
    const headLength = Math.min(text.length, CAPTURE_CHARS - head.length);
    head += text.slice(0, headLength);
    const remaining = text.length - headLength;
    if (!remaining) return;
    truncated ||= tail.length + remaining > CAPTURE_CHARS;
    const suffix = text.slice(Math.max(headLength, text.length - CAPTURE_CHARS));
    tail = (tail + suffix).slice(-CAPTURE_CHARS);
  }

  try {
    for await (const chunk of stream) {
      capture(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    }
  } catch {
    // A closed pipe can still have emitted enough output to identify the error.
  }
  capture(decoder.decode());
  return truncated ? classify(head, args) ?? classify(tail, args) : classify(head + tail, args);
}
