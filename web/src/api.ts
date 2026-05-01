const API_URL = (import.meta.env.VITE_FT_API_URL as string | undefined) ?? 'http://localhost:5001';

const SESSION_KEY = 'hearth.session';
const SHARE_KEY = 'hearth.share';
const ORG_SLUG_KEY = 'hearth.org_slug';

export interface Session {
  token: string;
  usr_id: string;
  expires_at: string;
}

export function getSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setSession(s: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export function getShareToken(): string | null {
  return sessionStorage.getItem(SHARE_KEY);
}

export function setShareToken(token: string): void {
  sessionStorage.setItem(SHARE_KEY, token);
}

export function clearShareToken(): void {
  sessionStorage.removeItem(SHARE_KEY);
}

export function getActiveOrgSlug(): string | null {
  return localStorage.getItem(ORG_SLUG_KEY);
}

export function setActiveOrgSlug(slug: string): void {
  localStorage.setItem(ORG_SLUG_KEY, slug);
}

export function clearActiveOrgSlug(): void {
  localStorage.removeItem(ORG_SLUG_KEY);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  bearer?: string | 'session' | 'share' | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly payload: unknown;
  constructor(status: number, code: string, message: string, payload: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  let bearer: string | null = null;
  if (options.bearer === 'session') {
    bearer = getSession()?.token ?? null;
  } else if (options.bearer === 'share') {
    bearer = getShareToken();
  } else if (typeof options.bearer === 'string') {
    bearer = options.bearer;
  }
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const resp = await fetch(`${API_URL}${path}`, init);

  const text = await resp.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!resp.ok) {
    const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const errBlock = (obj.error && typeof obj.error === 'object' ? obj.error : obj) as Record<
      string,
      unknown
    >;
    const code = typeof errBlock.code === 'string' ? errBlock.code : `http_${resp.status}`;
    const message = typeof errBlock.message === 'string' ? errBlock.message : resp.statusText;
    throw new ApiError(resp.status, code, message, parsed);
  }

  return parsed as T;
}

export const API_BASE_URL = API_URL;
