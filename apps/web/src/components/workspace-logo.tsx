'use client';
import { cn } from '@/lib/utils';
import { useMe } from '@/lib/me';

/** The current workspace's logo, or nothing when it has none. */
export function WorkspaceLogo({ className }: { className?: string }) {
  const ws = useMe().data?.workspace;
  if (!ws?.logoUpdatedAt) return null;
  return (
    // A same-origin, session-authenticated image: next/image would add nothing here.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/v1/workspace/logo?v=${ws.logoUpdatedAt}`}
      alt=""
      className={cn('w-auto shrink-0 object-contain', className)}
    />
  );
}
