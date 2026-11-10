import { redirect } from 'next/navigation';

/** The suppression list moved into Settings (docs/ui.md §3.9). */
export default function SuppressionRedirect() {
  redirect('/settings?tab=suppression');
}
