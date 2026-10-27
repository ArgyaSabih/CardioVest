import { Suspense } from 'react';
import Login from '@/src/screens/Login.jsx';

export const metadata = { title: 'Masuk' };

export default function Page() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
