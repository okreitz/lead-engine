import { EmptyState } from '@/components/blocks/empty-state';

export default function InboxPage() {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      <EmptyState
        title="Conversations arrive in Phase 4"
        next="Approve your offer profile so its intent phrases are ready"
        href="/offer"
      >
        Public threads where people ask for what you sell (Hacker News, Bluesky, Stack Exchange,
        GitHub, Reddit via search), scored and with a draft reply you copy and post yourself.
      </EmptyState>
    </div>
  );
}
