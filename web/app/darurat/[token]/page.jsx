import { Suspense } from 'react';
import Emergency from '@/src/screens/Emergency.jsx';

export const metadata = { title: 'Darurat', robots: { index: false } };

export default function Page() {
  return (
    <Suspense>
      <Emergency />
    </Suspense>
  );
}
