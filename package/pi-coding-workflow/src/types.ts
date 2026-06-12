export type WorkflowAgent = "research" | "implement" | "check" | "finish";
export type WorkflowStatus = "no_task" | "planning" | "in_progress" | "completed";
export type WorkflowStage = "grill" | "execute" | "finish";
export type FlowLevel = "simple" | "standard" | "complex" | "goal";
export type ContextMode = "none" | "lite" | "brief" | "task" | "check" | "finish";
export type DetailMode = "lite" | "summary" | "normal" | "full";
export type RunMode = "dry_run" | "execute";
export type ProfileName = "generic" | "unity";

export interface WorkflowBlocker {
  code: string;
  message: string;
  severity: "blocking" | "high" | "medium" | "low";
  path?: string;
}

export interface WorkflowWarning {
  code: string;
  message: string;
  path?: string;
}

export interface WorkflowOmittedArtifact {
  kind: string;
  ref: string;
  bytes: number;
  reason: string;
}

export interface WorkflowTokenBudget {
  estimatedInput: number;
  maxRecommended: number;
  cacheHit: boolean;
  truncatedBytes?: number;
  omittedRefs?: string[];
}

export interface WorkflowResultMeta {
  estimatedTokens: number;
  targetTokens?: number;
  maxRecommendedTokens?: number;
  truncatedBytes?: number;
  omittedRefs?: string[];
  durationMs?: number;
  cacheHit?: boolean;
}

export interface WorkflowSubagentBrief {
  agent: WorkflowAgent;
  goal: string;
  triggerCodes: string[];
  contextRefs: string[];
  instructions: string[];
  stopConditions: string[];
  expectedOutput: string;
}

export interface WorkflowAdaptiveControl {
  strategy: "deterministic_preflight" | "subagent_brief" | "ask_user" | "none";
  recommendedAgent: WorkflowAgent | "user" | "none";
  risk: "low" | "medium" | "high";
  confidence: number;
  reasons: string[];
  deterministicActions: WorkflowRecommendedCall[];
  subagentBriefs: WorkflowSubagentBrief[];
  stopConditions: string[];
}

export interface WorkflowContextSummary {
  mode: ContextMode;
  summary: string;
  prdHash?: string;
  artifactRef?: string | null;
  evidenceRefs?: string[];
  omitted?: WorkflowOmittedArtifact[];
  tokenBudget?: WorkflowTokenBudget;
  adaptiveControl?: WorkflowAdaptiveControl;
  details?: unknown;
}

export interface WorkflowNextInput {
  task?: string;
  agent?: WorkflowAgent;
  includeContext?: ContextMode;
  detail?: DetailMode;
}

export interface WorkflowNextOutput {
  ok: boolean;
  status: WorkflowStatus;
  task?: string;
  stage?: WorkflowStage;
  flowLevel?: FlowLevel;
  nextAction: "no_task_grill" | "start_checked" | "implement_slice" | "checkpoint" | "finish_dry_run" | "ask_user" | "blocked" | "none";
  recommendedTool?: { name: "workflow_run"; arguments: Partial<WorkflowRunInput> };
  blockedBy: WorkflowBlocker[];
  warnings: WorkflowWarning[];
  context?: WorkflowContextSummary;
  evidenceRefs?: string[];
  omitted?: WorkflowOmittedArtifact[];
  tokenBudget?: WorkflowTokenBudget;
  adaptiveControl?: WorkflowAdaptiveControl;
  cache?: { stableKey?: string; taskKey?: string; dynamicKey?: string; cacheKey?: string; cacheFriendly: boolean; hit?: boolean };
  artifactRef?: string;
  meta?: WorkflowResultMeta;
}

export type WorkflowRunAction = "create_from_grill" | "create_child" | "start_checked" | "checkpoint" | "finish_run" | "archive" | "batch";
export type WorkflowRunSingleAction = Exclude<WorkflowRunAction, "batch">;

export interface WorkflowRunBatchItem {
  action: WorkflowRunSingleAction;
  task?: string;
  mode?: RunMode;
  title?: string;
  level?: FlowLevel;
  slug?: string;
  parentTask?: string;
  phase?: "after-implementation" | "after-check" | "custom";
  profile?: ProfileName;
  notes?: string;
  message?: string;
  userConfirmed?: boolean;
}

export interface WorkflowRunInput {
  action: WorkflowRunAction;
  task?: string;
  mode?: RunMode;
  title?: string;
  level?: FlowLevel;
  slug?: string;
  parentTask?: string;
  phase?: "after-implementation" | "after-check" | "custom";
  profile?: ProfileName;
  notes?: string;
  message?: string;
  userConfirmed?: boolean;
  actions?: WorkflowRunBatchItem[];
}

export interface WorkflowArtifactRef {
  kind: string;
  ref: string;
  summary?: string;
}

export interface WorkflowRollbackHint {
  actionIndex: number;
  action: WorkflowRunSingleAction;
  kind: "remove_created_task" | "restore_task_json" | "manual";
  path?: string;
  summary: string;
  data?: unknown;
}

export interface WorkflowTransaction {
  id: string;
  mode: RunMode;
  state: "planned" | "committed" | "partial" | "failed";
  plannedActions: Array<{
    index: number;
    action: WorkflowRunSingleAction;
    mode: RunMode;
    task?: string;
    title?: string;
    summary: string;
  }>;
  rollbackHints: WorkflowRollbackHint[];
  artifactRef?: string;
}

export interface WorkflowRecommendedCall {
  name: "workflow_next" | "workflow_run";
  arguments: Record<string, unknown>;
}

export interface WorkflowRunOutput {
  ok: boolean;
  mutated: boolean;
  action: WorkflowRunAction;
  mode: RunMode;
  task?: string;
  status?: WorkflowStatus;
  stage?: WorkflowStage;
  nextAction?: string;
  blockedBy: WorkflowBlocker[];
  warnings: WorkflowWarning[];
  summary: string;
  artifactRef?: string;
  artifacts?: WorkflowArtifactRef[];
  checkpointId?: string;
  preflight?: unknown;
  git?: { committed?: boolean; commitHash?: string; pushed?: boolean; upstream?: string };
  nextRecommendedCall?: WorkflowRecommendedCall;
  meta?: WorkflowResultMeta;
  results?: WorkflowRunOutput[];
  transaction?: WorkflowTransaction;
  rollbackHints?: WorkflowRollbackHint[];
}

export interface ProjectWorkflowConfig {
  schemaVersion: 1;
  package: { name: "pi-coding-workflow"; requiredVersion?: string };
  project: { name?: string; profile: ProfileName; root: "." };
  workflow: { defaultFlowLevel: FlowLevel; taskDir: string; specDir: string; runtimeDir: string };
  context: { defaultMode: "lite" | "brief" | "none" | "task" | "check" | "finish"; maxSummaryChars: number; artifactMode: "summary-first" };
  git: { autoCommit: boolean; autoPush: boolean; pushConfirmation: "never" | "risky" | "always"; protectedBranches: string[]; allowBroadStage: false };
  profiles: { enabled: ProfileName[] };
}

export interface ScanSignal { type: string; path: string; profile?: ProfileName; weight?: number; message?: string }
export interface PlanQuestion { id: string; severity: "blocking" | "non_blocking"; question: string; options?: string[]; defaultAnswer?: string; reason: string }
export interface PlanAssumption { id: string; text: string; risk: "low" | "medium" | "high" }
export interface PlanOperation { op: "create" | "modify" | "skip"; path: string; template?: string; contentHash?: string; required: boolean; risk: "low" | "medium" | "high"; reason: string; preview?: string }

export interface InitSpecPlan {
  schemaVersion: 1;
  kind: "workflow-init-spec-plan";
  planId: string;
  createdAt: string;
  package: { name: "pi-coding-workflow"; version: string };
  project: { root: string; name?: string; detectedProfiles: ProfileName[]; selectedProfile: ProfileName; confidence: number };
  scan: { signals: ScanSignal[]; summary: string };
  facts: Record<string, unknown>;
  operations: PlanOperation[];
  questions: PlanQuestion[];
  assumptions: PlanAssumption[];
  blockedBy: string[];
  summary: { willCreate: number; willModify: number; willSkip: number; blocked: boolean };
}
