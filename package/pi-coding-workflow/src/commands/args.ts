const VALUE_KEYS = new Set(["profile", "plan", "task", "message", "answer"]);

export function parseArgs(args: string): Record<string, string | boolean> {
  const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = tokens[i + 1];
    if (!next || next.startsWith("--")) result[key] = VALUE_KEYS.has(key) ? "" : true;
    else {
      result[key] = next;
      i++;
    }
  }
  return result;
}

export function parseAnswers(args: Record<string, string | boolean>): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "answer" && typeof value === "string") {
      const [answerKey, ...rest] = value.split("=");
      if (answerKey && rest.length > 0) answers[answerKey] = rest.join("=");
    }
  }
  return answers;
}
