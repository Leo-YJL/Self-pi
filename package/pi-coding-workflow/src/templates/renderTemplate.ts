export type TemplateVariables = Record<string, unknown>;

export function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "TODO(init-spec)";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "TODO(init-spec)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function renderTemplate(template: string, variables: TemplateVariables): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_match, key: string) => {
    const parts = key.split(".");
    let current: unknown = variables;
    for (const part of parts) {
      if (current && typeof current === "object" && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        current = undefined;
        break;
      }
    }
    return stringifyTemplateValue(current);
  });
}
