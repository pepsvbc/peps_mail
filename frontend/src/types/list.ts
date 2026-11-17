export type ListKind = "personal" | "shared";

/** "list" inserts one chip in compose; "expanded" inserts every member. */
export type ListDisplayMode = "list" | "expanded";

export interface ListMember {
  email: string;
  name: string;
}

export interface ListAccess {
  email: string;
  can_edit: boolean;
}

export interface DistributionList {
  id: string;
  name: string;
  kind: ListKind;
  display_mode: ListDisplayMode;
  owner_email: string;
  members: ListMember[];
  /** May change name, display mode and members. */
  can_edit: boolean;
  /** May delete; for shared lists also manage access (admins). */
  can_manage: boolean;
  /** Only returned to admins for shared lists. */
  access: ListAccess[] | null;
  created_at: string;
  updated_at: string;
}

export interface CreateListRequest {
  name: string;
  /** Omit to derive it: shared when `access` has anyone. */
  kind?: ListKind;
  display_mode: ListDisplayMode;
  members: ListMember[];
  access?: ListAccess[];
}

export interface UpdateListRequest {
  name?: string;
  display_mode?: ListDisplayMode;
  members?: ListMember[];
  access?: ListAccess[];
}

export interface ListUser {
  email: string;
  last_login: string;
}
