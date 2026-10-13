import { toast } from "sonner";

import { useAuthStore } from "@/stores/useAuthStore";

const API_BASE = (process.env.NEXT_PUBLIC_BASE_PATH || "") + "/api";

interface ApiError {
  code?: string;
  message?: string;
  status?: number;
  accountId?: string;
}

interface ErrorResponse {
  error?: ApiError;
}

interface AccountsResponse {
  accounts: Array<{
    id: string;
    email: string;
    imapHost: string;
    smtpHost: string;
  }>;
  browserSessionExpired?: boolean;
}

function handleAccountSessionExpired(error: ApiError): void {
  if (error.code === "ACCOUNT_SESSION_EXPIRED" && error.accountId) {
    useAuthStore.getState().removeAccount(error.accountId);
    toast.error(error.message ?? "Account session expired");
    fetch(`${API_BASE}/auth/accounts/${error.accountId}`, {
      method: "DELETE",
      headers: { "X-Requested-With": "XMLHttpRequest" },
      credentials: "same-origin",
    }).catch(() => {});
  }
}

async function parseErrorResponse(res: Response, handleSessionExpiry = true): Promise<Error> {
  const data: ErrorResponse = await res.json();
  const error = data.error ?? {};
  if (handleSessionExpiry) handleAccountSessionExpired(error);
  return new Error(error.message ?? "An unexpected error occurred");
}

function getActiveAccountHeader(accountId = useAuthStore.getState().activeAccountId): Record<string, string> {
  return accountId ? { "X-Active-Account": accountId } : {};
}

export async function fetchAccounts(): Promise<AccountsResponse> {
  const res = await fetch(`${API_BASE}/auth/accounts`, {
    credentials: "same-origin",
  });

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  const data: AccountsResponse = await res.json();
  
  if (data.browserSessionExpired) {
    useAuthStore.getState().setAccounts([]);
  }
  
  return data;
}

export async function apiPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...getActiveAccountHeader(),
    },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  return res.json();
}

export async function apiGet<T>(
  path: string,
  options: { accountId?: string; signal?: AbortSignal; handleSessionExpiry?: boolean } = {},
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...getActiveAccountHeader(options.accountId),
    },
    credentials: "same-origin",
    signal: options.signal,
  });

  if (!res.ok) {
    throw await parseErrorResponse(res, options.handleSessionExpiry);
  }

  return res.json();
}

export async function apiPatch<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...getActiveAccountHeader(),
    },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  return res.json();
}

export async function apiPostFormData<T>(
  path: string,
  formData: FormData,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      ...getActiveAccountHeader(),
    },
    credentials: "same-origin",
    body: formData,
  });

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  return res.json();
}

export async function apiPut<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      ...getActiveAccountHeader(),
    },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  return res.json();
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      ...getActiveAccountHeader(),
    },
    credentials: "same-origin",
  });

  if (!res.ok) {
    throw await parseErrorResponse(res);
  }

  return res.json();
}
