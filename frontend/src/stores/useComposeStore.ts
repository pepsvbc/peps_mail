"use client";

import { create, type StoreApi, type UseBoundStore } from "zustand";
import { useUiStore } from "@/stores/useUiStore";
import { useAuthStore } from "@/stores/useAuthStore";
import type { ComposeQuote, QuoteKind } from "@/lib/compose-quote";

export interface ReplyParams {
  sourceMessageKey?: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  /** Quoted original message, kept outside the editor (see lib/compose-quote.ts). */
  quote?: ComposeQuote | null;
  /** Whether the user allowed remote content for the original message; the quote preview blocks it otherwise. */
  remoteContentAllowed?: boolean;
  inReplyTo: string | null;
  references: string | null;
  fromIdentityId?: number | null;
  isHtml?: boolean;
}

export interface ForwardParams {
  sourceMessageKey?: string;
  subject: string;
  body: string;
  /** Forwarded original message, kept outside the editor (see lib/compose-quote.ts). */
  quote?: ComposeQuote | null;
  /** Whether the user allowed remote content for the original message; the quote preview blocks it otherwise. */
  remoteContentAllowed?: boolean;
  isHtml?: boolean;
}

export interface DraftResumeParams {
  id: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  quote?: ComposeQuote | null;
  inReplyTo: string | null;
  references: string | null;
  attachments: ComposeAttachment[];
  isHtml?: boolean;
}

export interface ComposeAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface ComposeState {
  focusBodyOnOpen: boolean;
  pendingSend: boolean;
  sourceMessageKey: string | null;
  isOpen: boolean;
  isMinimized: boolean;
  accountId: string | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string | null;
  draftId: string | null;
  showCc: boolean;
  showBcc: boolean;
  attachments: ComposeAttachment[];
  fromIdentityId: number | null;
  isHtml: boolean;
  signatureHtml: string;
  signatureEnabled: boolean;
  /** Quoted history of a reply or forward; never part of `body` (the editor content). */
  quoteKind: QuoteKind | null;
  quotedHtml: string | null;
  quotedText: string | null;
  /** Whether the quoted history is expanded below the editor. */
  showQuoted: boolean;
  /**
   * Whether the quote preview may load remote content: only when the user
   * allowed it for the original message. Resumed drafts always start blocked.
   */
  quoteRemoteAllowed: boolean;

  openCompose: (to?: string) => void;
  openReply: (params: ReplyParams) => void;
  openForward: (params: ForwardParams) => void;
  openDraft: (params: DraftResumeParams) => void;
  closeCompose: () => void;
  minimizeCompose: () => void;
  restoreCompose: () => void;
  setField: (field: "to" | "cc" | "bcc" | "subject" | "body", value: string) => void;
  setShowCc: (show: boolean) => void;
  setShowBcc: (show: boolean) => void;
  setDraftId: (id: string) => void;
  setFromIdentityId: (id: number | null) => void;
  setIsHtml: (v: boolean) => void;
  setSignatureHtml: (html: string) => void;
  setSignatureEnabled: (enabled: boolean) => void;
  setShowQuoted: (show: boolean) => void;
  removeQuote: () => void;
  addAttachments: (atts: ComposeAttachment[]) => void;
  removeAttachment: (id: string) => void;
  reset: () => void;
}

/** Wraps signature HTML in the standard signature block marker. */
export function wrapSignatureHtml(signatureHtml: string): string {
  if (!signatureHtml) return "";
  return `<div class="email-signature" data-signature="true"><p>-- </p>${signatureHtml}</div>`;
}

/**
 * Appends a signature block to the editor body. Quoted reply/forward content is
 * kept separately (see quotedHtml), so the signature always ends the editor
 * body and lands above the quote when the message is serialized.
 */
export function injectSignature(body: string, signatureHtml: string): string {
  const sigBlock = wrapSignatureHtml(signatureHtml);
  if (!sigBlock) return body;
  return body + sigBlock;
}

/** Replaces or removes the signature block in the body HTML. */
export function replaceSignatureInBody(body: string, newSignatureHtml: string): string {
  const sigRegex = /<div class="email-signature"[^>]*>[\s\S]*?<\/div>/;
  const newSigBlock = wrapSignatureHtml(newSignatureHtml);

  if (sigRegex.test(body)) {
    if (newSigBlock) {
      return body.replace(sigRegex, newSigBlock);
    }
    // Remove the signature block
    return body.replace(sigRegex, "");
  }

  // No existing signature — inject if we have one
  if (newSigBlock) {
    return injectSignature(body, newSignatureHtml);
  }
  return body;
}

/** Removes the signature block from the body HTML. */
export function removeSignatureFromBody(body: string): string {
  return body.replace(/<div class="email-signature"[^>]*>[\s\S]*?<\/div>/, "");
}

const initialState = {
  focusBodyOnOpen: false,
  pendingSend: false,
  sourceMessageKey: null as string | null,
  isOpen: false,
  isMinimized: false,
  accountId: null as string | null,
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "",
  inReplyTo: null as string | null,
  references: null as string | null,
  draftId: null as string | null,
  showCc: false,
  showBcc: false,
  attachments: [] as ComposeAttachment[],
  fromIdentityId: null as number | null,
  isHtml: true,
  signatureHtml: "",
  signatureEnabled: true,
  quoteKind: null as QuoteKind | null,
  quotedHtml: null as string | null,
  quotedText: null as string | null,
  showQuoted: false,
  quoteRemoteAllowed: false,
};

/**
 * Store fields for a quoted part. Replies follow the "previous messages" display
 * preference; forwards always start expanded (the forwarded content is the point).
 */
function quoteState(quote: ComposeQuote | null | undefined, remoteContentAllowed = false) {
  const showQuoted = quote?.kind === "forward" || !useUiStore.getState().collapseQuotes;
  return quote
    ? { quoteKind: quote.kind, quotedHtml: quote.html, quotedText: quote.text, showQuoted, quoteRemoteAllowed: remoteContentAllowed }
    : { quoteKind: null, quotedHtml: null, quotedText: null, showQuoted: false, quoteRemoteAllowed: false };
}

export type ComposeStore = UseBoundStore<StoreApi<ComposeState>>;

function createComposeStore(): ComposeStore {
  return create<ComposeState>((set, get) => ({
  ...initialState,

  openCompose: (to = "") => {
    if (get().isOpen || get().pendingSend) {
      openAdditionalComposer((state) => state.openCompose(to));
      return;
    }
    set({
    ...initialState,
    isOpen: true,
    accountId: useAuthStore.getState().activeAccountId,
    to,
    isHtml: useUiStore.getState().composeFormat !== "text",
    });
  },

  openReply: (params) => {
    if (get().pendingSend) {
      openAdditionalComposer((state) => state.openReply(params));
      return;
    }
    set((state) => state.isOpen ? { isMinimized: false } : {
      ...initialState,
      isOpen: true,
      focusBodyOnOpen: true,
      accountId: useAuthStore.getState().activeAccountId,
      to: params.to,
      cc: params.cc,
      sourceMessageKey: params.sourceMessageKey ?? null,
      subject: params.subject,
      body: params.body,
      ...quoteState(params.quote, params.remoteContentAllowed === true),
      inReplyTo: params.inReplyTo,
      references: params.references,
      showCc: params.cc.length > 0,
      fromIdentityId: params.fromIdentityId ?? null,
      isHtml: params.isHtml ?? true,
    });
  },

  openForward: (params) => {
    if (get().pendingSend) {
      openAdditionalComposer((state) => state.openForward(params));
      return;
    }
    set((state) => state.isOpen ? { isMinimized: false } : {
      ...initialState,
      isOpen: true,
      accountId: useAuthStore.getState().activeAccountId,
      sourceMessageKey: params.sourceMessageKey ?? null,
      subject: params.subject,
      body: params.body,
      ...quoteState(params.quote, params.remoteContentAllowed === true),
      isHtml: params.isHtml ?? true,
    });
  },

  openDraft: (params) => {
    if (get().pendingSend) {
      openAdditionalComposer((state) => state.openDraft(params));
      return;
    }
    set((state) => state.isOpen ? { isMinimized: false } : {
      ...initialState,
      isOpen: true,
      accountId: useAuthStore.getState().activeAccountId,
      draftId: params.id,
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject,
      body: params.body,
      ...quoteState(params.quote),
      inReplyTo: params.inReplyTo,
      references: params.references,
      showCc: params.cc.length > 0,
      showBcc: params.bcc.length > 0,
      attachments: params.attachments,
      isHtml: params.isHtml ?? true,
    });
  },

  closeCompose: () => set({ isOpen: false, isMinimized: false }),
  minimizeCompose: () => set((state) => ({ isMinimized: state.isOpen })),
  restoreCompose: () => set({ isMinimized: false }),

  setField: (field, value) => set({ [field]: value }),

  setShowCc: (show) => set({ showCc: show }),
  setShowBcc: (show) => set({ showBcc: show }),

  setDraftId: (id) => set({ draftId: id }),

  setFromIdentityId: (id) => set({ fromIdentityId: id }),

  setIsHtml: (v) => set({ isHtml: v }),

  setSignatureHtml: (html) => set({ signatureHtml: html }),

  setSignatureEnabled: (enabled) => set({ signatureEnabled: enabled }),

  setShowQuoted: (show) => set({ showQuoted: show }),

  removeQuote: () => set(quoteState(null)),

  addAttachments: (atts) =>
    set((state) => ({ attachments: [...state.attachments, ...atts] })),

  removeAttachment: (id) =>
    set((state) => ({
      attachments: state.attachments.filter((a) => a.id !== id),
    })),

  reset: () => set(initialState),
}));
}

let nextWindowId = 1;
export const useComposeStore = createComposeStore();
export const useComposeWindows = create<{
  windows: { id: number; store: ComposeStore }[];
  focusedStore: ComposeStore | null;
}>(() => ({ windows: [], focusedStore: null }));

function openAdditionalComposer(open: (state: ComposeState) => void) {
  const store = createComposeStore();
  open(store.getState());
  useComposeWindows.setState((state) => ({
    windows: [...state.windows.filter((window) => window.store.getState().isOpen || window.store.getState().pendingSend), { id: nextWindowId++, store }],
    focusedStore: store,
  }));
}
