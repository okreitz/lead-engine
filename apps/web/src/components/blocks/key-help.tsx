import { helpFor, keyHelpForText, type ProviderHelp } from '@le/shared';
import Link from 'next/link';

/** A link that opens a provider's own page in a new tab. */
export function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2"
    >
      {children}
    </a>
  );
}

/**
 * What a key is for, what it costs, where to create it and the minimum scope
 * (one source of truth: `PROVIDER_HELP` in @le/shared).
 */
export function KeyHelp({ help }: { help: ProviderHelp }) {
  return (
    <div className="text-muted-foreground flex flex-col gap-0.5 text-xs">
      <span>
        {help.usedFor} · {help.cost}
      </span>
      <span>
        <ExternalLink href={help.createUrl}>
          {help.createUrlIsDocs ? 'How to get it' : 'Create the key'} ↗
        </ExternalLink>
        {help.createUrlIsDocs ? ' (no direct page; vendor docs)' : ''}
        {help.scope ? ` · Minimum scope: ${help.scope}` : ''}
      </span>
    </div>
  );
}

/** Link to the provider's row in Settings → Provider keys. */
export function keySettingsHref(id: string): string {
  return `/settings?tab=keys#key-${id}`;
}

/**
 * Job wait reasons and errors: when the text is about a missing key, name it and link to
 * its settings row and to where the key is created.
 */
export function WaitReason({ text }: { text: string }) {
  const help = keyHelpForText(text);
  if (!help) return <>{text}</>;
  return (
    <>
      {text} ·{' '}
      <Link className="underline underline-offset-2" href={keySettingsHref(help.id)}>
        add the {help.label} key
      </Link>{' '}
      (<ExternalLink href={help.createUrl}>get one ↗</ExternalLink>)
    </>
  );
}

/** "Add the X key" inline note with both links, for empty states and cost dialogs. */
export function MissingKey({ id, what }: { id: string; what: string }) {
  const help = helpFor(id);
  if (!help) return null;
  return (
    <span>
      {what} needs a {help.label} key:{' '}
      <Link className="underline underline-offset-2" href={keySettingsHref(id)}>
        add it in Settings → Provider keys
      </Link>{' '}
      (<ExternalLink href={help.createUrl}>get one ↗</ExternalLink>).
    </span>
  );
}
