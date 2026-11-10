import { EmptyState } from '@/components/blocks/empty-state';

export default function VisitorsPage() {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Visitors</h1>
      <EmptyState title="Website visitors arrive in Phase 3">
        Install the snippet on your sites to see which US companies visit, with match rate and
        dropped traffic per site. Company level only, no cookies.
      </EmptyState>
    </div>
  );
}
