// Page size for a paginated thread query's own server fetches (the shared
// active-threads array's initial load and rail search, and any other surface
// built on useThreadQuery). Shared across App.tsx and ProjectsPanel.tsx —
// do not redefine it locally.
export const THREAD_PAGE_SIZE = 30;

/**
 * A chat list is honestly empty only when the server has confirmed there is
 * nothing more to fetch. A zero-length list mid-fetch is a partial answer, and
 * rendering "No chats yet" over it is a confident lie.
 */
export function isThreadListEmpty(input: {
  count: number;
  loading: boolean;
  exhausted: boolean;
}): boolean {
  return input.count === 0 && input.exhausted && !input.loading;
}
