export interface DelegateSessionEvent {
  type: string;
}

export interface DelegateSession {
  subscribe(listener: (event: DelegateSessionEvent) => void): () => void;
  prompt(prompt: string): Promise<void>;
  abort(): Promise<void> | void;
  dispose(): void;
  messages?: unknown[];
  state?: { messages?: unknown[] };
  agent?: { state?: { messages?: unknown[] } };
}

export interface DelegateSdkSurface {
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(): Promise<void> };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: DelegateSession }>;
  SessionManager: { inMemory(root: string): unknown };
  defineTool: unknown;
}

export interface DelegateSdkLoadResult {
  sdk: DelegateSdkSurface;
  Type: any;
}

let testDelegateSdk: DelegateSdkLoadResult | undefined;

export function setDelegateSdkForTest(mock?: DelegateSdkLoadResult): void {
  testDelegateSdk = mock;
}

export async function loadDelegateSdk(): Promise<DelegateSdkLoadResult> {
  if (testDelegateSdk) return testDelegateSdk;
  const sdk = await import("@earendil-works/pi-coding-agent") as unknown as DelegateSdkSurface;
  const Type = (await import("typebox")).Type;
  return { sdk, Type };
}
