import { redirect } from 'next/navigation';

// Legacy URL: the workstreams list moved from /requests to /dashboard. Keep this
// route so any bookmarks or stale UI links still land on the right page.
export default function RequestsRedirect(): never {
  redirect('/dashboard');
}
