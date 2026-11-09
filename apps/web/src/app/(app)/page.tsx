'use client';
import { Card, CardTitle } from '@/components/ui/card';
import { useMe } from '@/lib/me';

export default function Overview() {
  const me = useMe();
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{me.data?.workspace?.name}</h1>
      <Card>
        <CardTitle>Overview</CardTitle>
        <p className="text-muted-foreground text-sm">
          The pipeline summary arrives with the CRM. Configure the workspace under Settings.
        </p>
      </Card>
    </div>
  );
}
