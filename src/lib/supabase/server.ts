import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { connection } from 'next/server';

// Supabase client for Server Components, Server Actions and Route Handlers.
// It acts as the signed-in person, so row-level security decides what comes back.
export async function createClient() {
  // Supabase reads the clock (token expiry), which Cache Components forbids during prerendering.
  // Waiting for the real request first keeps every database read at request time.
  await connection();
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only. The proxy refreshes the session instead.
        }
      },
    },
  });
}
