import { json, route } from '@/lib/api';

export const dynamic = 'force-dynamic';

// endpoint yang tidak dikenal
const notFound = route(async () => json({ error: 'Endpoint tidak dikenal.' }, 404));
export { notFound as GET, notFound as POST, notFound as PUT, notFound as DELETE };
