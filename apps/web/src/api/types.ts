export type Category = 'furniture' | 'souvenir' | 'receipt' | 'manuscript' | 'other';
export type ItemStatus = 'draft' | 'published' | 'archived' | 'trashed';
export type Visibility = 'private' | 'family' | 'selected' | 'link';
export type Precision = 'day' | 'month' | 'year' | 'decade' | 'unknown';
export type FamilyRole = 'owner' | 'admin' | 'editor' | 'contributor' | 'viewer';
export type PersonRole = 'source' | 'gifted' | 'inherited' | 'owner' | 'mentioned';
export type MediaKind = 'image' | 'audio' | 'document';
export type MediaStatus = 'processing' | 'ready' | 'failed';

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarColor: string;
  systemRole: 'sysadmin' | 'user';
  createdAt: string;
}

export interface Membership {
  familyId: string;
  familyName: string;
  role: FamilyRole;
  status: string;
  memberCount: number;
  itemCount: number;
}

export interface SessionResponse {
  user: User;
  accessToken: string;
  memberships: Membership[];
}

export interface Media {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  originalName: string;
  caption: string | null;
  transcript: string | null;
  sortOrder: number;
  hasThumb: boolean;
  hasWaveform: boolean;
  rawUrl: string;
  thumbUrl: string | null;
  waveformUrl: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface ItemPerson {
  personId: string;
  role: PersonRole;
  name: string;
  relation: string | null;
}

export interface Item {
  id: string;
  familyId: string;
  title: string;
  category: Category;
  status: ItemStatus;
  visibility: Visibility;
  acquiredAt: string | null;
  acquiredPrecision: Precision;
  acquiredLabel: string | null;
  acquiredNote: string | null;
  acquiredDisplay: string;
  timeUncertain: boolean;
  placeText: string | null;
  placeCity: string | null;
  placeProvince: string | null;
  placeCountry: string | null;
  storyHtml: string | null;
  storyText: string | null;
  condition: string | null;
  storageLocation: string | null;
  tags: string[];
  sortAt: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  coverMediaId: string | null;
  mediaCount: number;
  noteCount: number;
  media: Media[];
  people: ItemPerson[];
}

export interface ItemDetail extends Item {
  creator: { id: string; displayName: string; avatarColor: string };
  notes: Note[];
  sharedWith: { userId: string; displayName: string; avatarColor: string; canEdit: boolean }[];
  versionCount: number;
  permissions: { canEdit: boolean; canDelete: boolean; canComment: boolean; canManageMedia: boolean };
}

export interface Note {
  id: string;
  type: 'story' | 'comment' | 'correction';
  body: string;
  status: 'pending' | 'accepted' | 'rejected';
  rejectReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  author: { id: string; displayName: string; avatarColor: string } | null;
}

export interface Person {
  id: string;
  familyId: string;
  name: string;
  relation: string | null;
  birthYear: number | null;
  deathYear: number | null;
  bio: string | null;
  itemCount: number;
  createdAt: string;
}

export interface PersonDetail extends Person {
  items: (Item & { role: PersonRole })[];
}

export interface Member {
  userId: string;
  role: FamilyRole;
  status: 'active' | 'disabled';
  joinedAt: string;
  user: { id: string; email: string; displayName: string; avatarColor: string };
}

export interface FamilyDetail {
  id: string;
  name: string;
  description: string | null;
  defaultVisibility: Visibility;
  allowViewerComment: boolean;
  createdAt: string;
  counts: { members: number; items: number; people: number };
}

export interface TimelineGroup {
  key: string;
  label: string;
  count: number;
  items: Item[];
}

export interface ShareLink {
  id: string;
  label: string | null;
  expiresAt: string;
  revokedAt: string | null;
  accessCount: number;
  lastAccessAt: string | null;
  hasPassword: boolean;
  createdAt: string;
  url: string | null;
  token?: string;
}

export interface AuditLog {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  diff: unknown;
  ip: string | null;
  createdAt: string;
  actor: { id: string; displayName: string; avatarColor: string };
}

export interface FamilyStats {
  totalItems: number;
  totalMedia: number;
  totalBytes: number;
  recentItems: number;
  byCategory: { category: Category; count: number }[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type RepairType = 'thumbnail' | 'waveform' | 'duration';
export type RepairBatchStatus = 'running' | 'done' | 'failed' | 'partial';

export interface RepairPlan {
  repairs: RepairType[];
  totalTargets: number;
  byRepair: Record<RepairType, number>;
  estimatedBytes: number;
  uniqueFiles: number;
}

export interface RepairFailure {
  mediaId: string;
  repair: RepairType;
  error: string;
}

export interface RepairBatch {
  id: string;
  familyId: string;
  status: RepairBatchStatus;
  repairs: RepairType[];
  progress: number;
  totalTargets: number;
  totalJobs: number;
  succeededTargets: number;
  failedTargets: number;
  estimatedBytes: number;
  actualBytes: number;
  sourceMissing: number;
  failures: RepairFailure[];
  createdAt: string;
  finishedAt: string | null;
}

