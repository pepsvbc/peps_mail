"use client";

import { useTranslation } from "@/lib/i18n";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Eye, List, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useDeleteList, useLists } from "@/hooks/useLists";
import type { DistributionList } from "@/types/list";
import { DistributionListDialog } from "./DistributionListDialog";

function ListRow({
  list,
  onOpen,
  onDelete,
}: {
  list: DistributionList;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border p-4" data-testid="distribution-list-row">
      <div className="flex min-w-0 items-center gap-3">
        <List className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{list.name}</span>
            {list.kind === "shared" && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                {t("Shared")}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(list.members.length === 1 ? "{count} member" : "{count} members", { count: list.members.length })}
            {" · "}
            {list.display_mode === "list" ? t("Shown as one list") : t("Shows every address")}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {list.can_edit ? (
          <button
            type="button"
            onClick={onOpen}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t("Edit {name}", { name: list.name })}
            title={t("Edit")}
          >
            <Pencil className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t("View members of {name}", { name: list.name })}
            title={t("View members")}
          >
            <Eye className="size-4" />
          </button>
        )}
        {list.can_manage && (
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"
            aria-label={t("Delete {name}", { name: list.name })}
            title={t("Delete")}
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
    </li>
  );
}

function ListGroup({
  title,
  empty,
  lists,
  onOpen,
  onDelete,
}: {
  title: string;
  empty: string;
  lists: DistributionList[];
  onOpen: (list: DistributionList) => void;
  onDelete: (list: DistributionList) => void;
}) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      {lists.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {lists.map((list) => (
            <ListRow key={list.id} list={list} onOpen={() => onOpen(list)} onDelete={() => onDelete(list)} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Dedicated page for personal and shared distribution lists (left navigation bar). */
export function DistributionListsPage() {
  const { t } = useTranslation();
  const { data: lists, isLoading, isError, error } = useLists();
  const deleteList = useDeleteList();
  const [dialog, setDialog] = useState<{ list: DistributionList | null } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DistributionList | null>(null);

  const personal = (lists ?? []).filter((l) => l.kind === "personal");
  const shared = (lists ?? []).filter((l) => l.kind === "shared");

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    deleteList.mutate(target.id, {
      onSuccess: () => {
        toast.success(t("List deleted"));
        setPendingDelete(null);
      },
      onError: (e) => toast.error(t("Failed to delete: {error}", { error: e.message })),
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border px-4 py-4 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">{t("Distribution lists")}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t("Write to a whole group at once, for example a team. Type the list name in To, Cc or Bcc.")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDialog({ list: null })}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
          >
            <Plus className="size-4" />
            {t("New list")}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("Loading lists...")}
            </div>
          ) : isError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("Could not load lists: {error}", { error: error?.message ?? "" })}
            </p>
          ) : (
            <>
              <ListGroup
                title={t("My lists")}
                empty={t("You have no lists yet. Create one to write to a group in one go.")}
                lists={personal}
                onOpen={(list) => setDialog({ list })}
                onDelete={setPendingDelete}
              />
              <ListGroup
                title={t("Shared lists")}
                empty={t("No lists have been shared with you.")}
                lists={shared}
                onOpen={(list) => setDialog({ list })}
                onDelete={setPendingDelete}
              />
            </>
          )}
        </div>
      </div>

      <DistributionListDialog open={dialog !== null} list={dialog?.list ?? null} onClose={() => setDialog(null)} />

      <AlertDialog.Root open={pendingDelete !== null} onOpenChange={(open) => !open && !deleteList.isPending && setPendingDelete(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-6 shadow-2xl">
            <AlertDialog.Title className="text-base font-semibold">
              {t("Delete “{name}”?", { name: pendingDelete?.name ?? "" })}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
              {pendingDelete?.kind === "shared"
                ? t("The list will be removed for everyone who can use it. Messages already sent are not affected.")
                : t("Messages already sent are not affected.")}
            </AlertDialog.Description>
            <div className="mt-6 flex items-center justify-end gap-3">
              <AlertDialog.Cancel asChild>
                <button className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground" disabled={deleteList.isPending}>
                  {t("Cancel")}
                </button>
              </AlertDialog.Cancel>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleteList.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-white hover:bg-destructive/90 disabled:opacity-50"
              >
                {deleteList.isPending && <Loader2 className="size-3.5 animate-spin" />}
                {t("Delete")}
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
