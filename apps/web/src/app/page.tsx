import { PORTS } from '@le/shared';
import { Button } from '@/components/ui/button';

export default function Home() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Lead Engine</h1>
      <p className="text-muted-foreground">
        Phase 0 scaffold. The CRM, inbox and offer editor arrive in Phase 1.
      </p>
      <ul className="text-sm">
        <li>Web: 127.0.0.1:{PORTS.web}</li>
        <li>Engine API: 127.0.0.1:{PORTS.engine}</li>
        <li>Collector: 127.0.0.1:{PORTS.collector}</li>
      </ul>
      <div>
        <Button asChild variant="outline">
          <a href="https://github.com/okreitz/lead-engine">Source (AGPL-3.0)</a>
        </Button>
      </div>
    </main>
  );
}
