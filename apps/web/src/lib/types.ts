export interface Workspace {
  id: string;
  name: string;
  slug: string;
  monthlyBudgetUsd: number;
  timezone: string;
  settings: {
    stages?: string[];
    scoreWeights?: { fit: number; intent: number };
    fitThreshold?: number;
    llmAdapter?: 'claude-cli' | 'anthropic-api';
    llmModel?: string;
    subCaps?: Record<string, number>;
    enforceSubCaps?: boolean;
  };
  /** Set when the workspace has a logo; also its cache-busting version. */
  logoUpdatedAt?: number | null;
}

export interface Me {
  user: { id: string; email: string };
  csrfToken: string;
  role: 'owner' | 'member' | null;
  workspace: Workspace | null;
  workspaces: { id: string; name: string; slug: string; role: string }[];
}
