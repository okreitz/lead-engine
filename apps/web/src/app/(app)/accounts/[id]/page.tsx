'use client';
import { useParams } from 'next/navigation';
import { AccountView } from '@/components/account-view';

export default function AccountPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="max-w-7xl">
      <AccountView id={id} />
    </div>
  );
}
