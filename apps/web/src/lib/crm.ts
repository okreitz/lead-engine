export interface AccountRow {
  id: string;
  name: string;
  domain: string;
  state: string | null;
  industry: string | null;
  sizeRange: string | null;
  stage: string;
  fitScore: number | null;
  intentScore: number;
  priority: number;
  firstSource: string;
  status: string;
  updatedAt: number;
  createdAt: number;
}

export interface Contact {
  id: string;
  accountId: string;
  fullName: string;
  title: string | null;
  seniority: string | null;
  department: string | null;
  personaMatch: string | null;
  email: string | null;
  emailStatus: string | null;
  phone: string | null;
}

export interface FieldSource {
  id: string;
  entity: string;
  entityId: string;
  field: string;
  source: string;
  url: string | null;
  fetchedAt: number;
  confidence: number;
}

export interface Activity {
  id: string;
  kind: string;
  body: string;
  at: number;
  contactId: string | null;
  dealId: string | null;
}

export interface Signal {
  id: string;
  stream: string;
  kind: string;
  weight: number;
  occurredAt: number;
  payload: Record<string, unknown>;
  evidenceUrl: string | null;
}

export interface AccountDetail {
  account: {
    id: string;
    stage: string;
    fitScore: number | null;
    intentScore: number;
    priority: number;
    scoreReasons: { fit: string[]; intent: string[] } | null;
    scoredAt: number | null;
    firstSource: string;
    firstSourceAt: number;
    status: string;
  };
  company: {
    id: string;
    domain: string;
    name: string;
    country: string;
    state: string | null;
    city: string | null;
    industry: string | null;
    naics: string | null;
    sizeRange: string | null;
    foundedYear: number | null;
    tech: string[];
  };
  contacts: Contact[];
  deals: {
    id: string;
    name: string;
    stage: string;
    valueUsd: number | null;
    outcome: string | null;
  }[];
  activities: Activity[];
  nextSteps: { id: string; text: string; dueAt: number | null; doneAt: number | null }[];
  signals: Signal[];
  fieldSources: FieldSource[];
}

export const EMAIL_STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted'> = {
  verified: 'ok',
  pattern_verified: 'ok',
  catch_all: 'warn',
  risky: 'warn',
  unknown: 'muted',
  invalid: 'danger',
};

export const CAN_SPAM_CHECKLIST = [
  'Accurate From, To, Reply-To and routing information',
  'A subject line that reflects the content',
  'Identify the message as an ad where required',
  'Include a valid physical postal address',
  'A clear, working way to opt out, honoured within 10 business days',
];

export const score = (n: number | null | undefined) => (n == null ? '—' : Math.round(n));
