/**
 * EXTRACT — Roomglow case study.
 *
 * Copied verbatim from the private Roomglow repository, and deliberately incomplete: the
 * modules it imports (the database layer, the HTTP router, the routes, the seed) are not
 * published here, so this will not compile or run on its own. It is here to be read.
 *
 * (c) Abdullah Rathore. All rights reserved.
 */

/**
 * The product, in one file: rooms, the places they can be, and the rules about believing
 * what the board says.
 *
 * The central idea is that a status is a *claim an educator made at a time*, not a fact.
 * So nothing here ever invents a location — there is no default "In Classroom" — and
 * every read carries how old the claim is and whether it should still be trusted.
 */
import { getNumberSetting, many, one, run, tx } from './db.ts';
import { presence, type Audience } from './events.ts';
import { clampText, minutesBetween, newId, nowIso } from './util.ts';
import type { User } from './auth.ts';

export type LocationKind = 'indoor' | 'outdoor' | 'transition' | 'activity' | 'offsite';

export interface Location {
  id: string;
  label: string;
  kind: LocationKind;
  icon: string;
  sort_order: number;
  archived_at: string | null;
}

export interface Room {
  id: string;
  name: string;
  short_name: string;
  age_group: string | null;
  accent: string;
  sort_order: number;
  archived_at: string | null;
}

/** How long a claim is treated as current, and how long a transition may last. */
export const DEFAULT_FRESH_MINUTES = 45;
export const DEFAULT_TRANSITION_MINUTES = 10;

export function thresholds(): { freshMinutes: number; transitionMinutes: number } {
  return {
    freshMinutes: getNumberSetting('fresh_minutes', DEFAULT_FRESH_MINUTES),
    transitionMinutes: getNumberSetting('transition_minutes', DEFAULT_TRANSITION_MINUTES),
  };
}

// --------------------------------------------------------------- reading them

export function listLocations(includeArchived = false): Location[] {
  return many<Location>(
    `SELECT id, label, kind, icon, sort_order, archived_at FROM locations
      ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
      ORDER BY sort_order, label`,
  );
}

export function findLocation(id: string): Location | null {
  return one<Location>('SELECT id, label, kind, icon, sort_order, archived_at FROM locations WHERE id = ?', id);
}

export function listRooms(includeArchived = false): Room[] {
  return many<Room>(
    `SELECT id, name, short_name, age_group, accent, sort_order, archived_at FROM rooms
      ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
      ORDER BY sort_order, name`,
  );
}

export function findRoom(id: string): Room | null {
  return one<Room>(
    'SELECT id, name, short_name, age_group, accent, sort_order, archived_at FROM rooms WHERE id = ?',
    id,
  );
}

export type Freshness = 'unset' | 'fresh' | 'stale' | 'overdue';

interface StateRow {
  room_id: string;
  location_id: string | null;
  note: string | null;
  back_by: string | null;
  version: number;
  updated_at: string | null;
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  source: string | null;
  confirm_requested_at: string | null;
  confirm_requested_by: string | null;
}

/** What the lobby TV is allowed to know. No names. No notes. By construction. */
export interface KioskRoom {
  id: string;
  name: string;
  shortName: string;
  ageGroup: string | null;
  accent: string;
  location: string | null;
  locationKind: LocationKind | null;
  icon: string | null;
  updatedAt: string | null;
  minutesSince: number | null;
  freshness: Freshness;
  backBy: string | null;
}

/** What a signed-in member of staff sees in addition. */
export interface StaffRoom extends KioskRoom {
  note: string | null;
  actorName: string | null;
  actorRole: string | null;
  source: string | null;
  version: number;
  confirmRequestedAt: string | null;
  connectedDevices: number;
}

export interface Board {
  audience: Audience;
  generatedAt: string;
  thresholds: { freshMinutes: number; transitionMinutes: number };
  rooms: KioskRoom[] | StaffRoom[];
  counts: { total: number; stale: number; unset: number; outdoors: number; inTransition: number };
}

export function freshnessOf(
  state: Pick<StateRow, 'updated_at' | 'location_id'>,
  kind: LocationKind | null,
  limits = thresholds(),
  now = nowIso(),
): { freshness: Freshness; minutesSince: number | null } {
  if (!state.updated_at || !state.location_id) return { freshness: 'unset', minutesSince: null };
  const minutes = Math.max(0, Math.round(minutesBetween(state.updated_at, now)));
  // A transition is meant to last minutes. One that has lasted longer is the single most
  // useful warning this product can give reception: nobody is where the board says.
  if (kind === 'transition' && minutes > limits.transitionMinutes) {
    return { freshness: 'overdue', minutesSince: minutes };
  }
  if (minutes > limits.freshMinutes) return { freshness: 'stale', minutesSince: minutes };
  return { freshness: 'fresh', minutesSince: minutes };
}

interface JoinedRow extends StateRow, Room {
  location_label: string | null;
  location_kind: LocationKind | null;
  location_icon: string | null;
}

function joinedRows(roomId?: string): JoinedRow[] {
  return many<JoinedRow>(
    `SELECT r.id, r.name, r.short_name, r.age_group, r.accent, r.sort_order, r.archived_at,
            s.room_id, s.location_id, s.note, s.back_by, s.version, s.updated_at,
            s.actor_id, s.actor_name, s.actor_role, s.source,
            s.confirm_requested_at, s.confirm_requested_by,
            l.label AS location_label, l.kind AS location_kind, l.icon AS location_icon
       FROM rooms r
       LEFT JOIN room_state s ON s.room_id = r.id
       LEFT JOIN locations  l ON l.id = s.location_id
      WHERE r.archived_at IS NULL ${roomId ? 'AND r.id = ?' : ''}
      ORDER BY r.sort_order, r.name`,
    ...(roomId ? [roomId] : []),
  );
}

function toKiosk(row: JoinedRow, limits: ReturnType<typeof thresholds>, now: string): KioskRoom {
  const { freshness, minutesSince } = freshnessOf(row, row.location_kind, limits, now);
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    ageGroup: row.age_group,
    accent: row.accent,
    location: row.location_label,
    locationKind: row.location_kind,
    icon: row.location_icon,
    updatedAt: row.updated_at,
    minutesSince,
    freshness,
    backBy: row.back_by,
  };
}

function toStaff(
  row: JoinedRow,
  limits: ReturnType<typeof thresholds>,
  now: string,
  devices: Record<string, number>,
): StaffRoom {
  return {
    ...toKiosk(row, limits, now),
    note: row.note,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    source: row.source,
    version: row.version ?? 0,
    confirmRequestedAt: row.confirm_requested_at,
    connectedDevices: devices[row.id] ?? 0,
  };
}

export function buildBoard(audience: Audience): Board {
  const limits = thresholds();
  const now = nowIso();
  const rows = joinedRows();
  const devices = presence().rooms;

  const rooms =
    audience === 'kiosk'
      ? rows.map((row) => toKiosk(row, limits, now))
      : rows.map((row) => toStaff(row, limits, now, devices));

  return {
    audience,
    generatedAt: now,
    thresholds: limits,
    rooms,
    counts: {
      total: rooms.length,
      stale: rooms.filter((r) => r.freshness === 'stale' || r.freshness === 'overdue').length,
      unset: rooms.filter((r) => r.freshness === 'unset').length,
      outdoors: rooms.filter((r) => r.locationKind === 'outdoor').length,
      inTransition: rooms.filter((r) => r.locationKind === 'transition').length,
    },
  };
}

/** The id, not the label — needed to re-stamp a confirmation on the same place. */
export function currentLocationId(roomId: string): string | null {
  return one<{ location_id: string | null }>('SELECT location_id FROM room_state WHERE room_id = ?', roomId)
    ?.location_id ?? null;
}

export function roomForStaff(roomId: string): StaffRoom | null {
  const row = joinedRows(roomId)[0];
  if (!row) return null;
  return toStaff(row, thresholds(), nowIso(), presence().rooms);
}

// --------------------------------------------------------------- changing them

export type SetStatusOutcome =
  | { status: 'ok'; room: StaffRoom; repeated: boolean }
  | { status: 'conflict'; room: StaffRoom }
  | { status: 'no_room' }
  | { status: 'no_location' }
  | { status: 'bad_back_by' };

export interface SetStatusInput {
  roomId: string;
  locationId: string;
  note?: unknown;
  /** Minutes from now, not a wall-clock time: the client's clock and timezone are not
   *  trusted to agree with the server's, and "back in 20 minutes" is what is meant. */
  backByMinutes?: unknown;
  /** The version the client last saw. Omit only for a deliberate override. */
  version?: number | null;
  actor: User;
  source: 'teacher' | 'admin' | 'confirm';
}

const NOTE_MAX = 120;
/** A repeated tap inside this window is the same intent, not a second decision. */
const REPEAT_WINDOW_MS = 5_000;

export function setStatus(input: SetStatusInput): SetStatusOutcome {
  const room = findRoom(input.roomId);
  if (!room || room.archived_at) return { status: 'no_room' };

  const location = findLocation(input.locationId);
  if (!location || location.archived_at) return { status: 'no_location' };

  const note = clampText(input.note, NOTE_MAX);

  let backBy: string | null = null;
  if (input.backByMinutes !== undefined && input.backByMinutes !== null && input.backByMinutes !== '') {
    const minutes = Number(input.backByMinutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) return { status: 'bad_back_by' };
    backBy = new Date(Date.now() + minutes * 60_000).toISOString();
  }

  return tx<SetStatusOutcome>(() => {
    const current = one<StateRow>('SELECT * FROM room_state WHERE room_id = ?', input.roomId);

    // Two educators in one room both tapped. Whoever read an older version is told what
    // happened and by whom, rather than having their change silently win or silently lose.
    if (
      input.version !== null &&
      input.version !== undefined &&
      current &&
      Number(current.version) !== Number(input.version)
    ) {
      return { status: 'conflict', room: roomForStaff(input.roomId)! };
    }

    // The same change again, within seconds, by the same person: a double tap on a
    // tablet held by someone who is also holding a child.
    if (
      current &&
      current.location_id === input.locationId &&
      (current.note ?? null) === note &&
      current.actor_id === input.actor.id &&
      current.updated_at &&
      Date.now() - Date.parse(current.updated_at) < REPEAT_WINDOW_MS
    ) {
      return { status: 'ok', room: roomForStaff(input.roomId)!, repeated: true };
    }

    const version = Number(current?.version ?? 0) + 1;
    const at = nowIso();

    run(
      `INSERT INTO room_state (room_id, location_id, note, back_by, version, updated_at,
                               actor_id, actor_name, actor_role, source,
                               confirm_requested_at, confirm_requested_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)
       ON CONFLICT(room_id) DO UPDATE SET
         location_id = excluded.location_id,
         note        = excluded.note,
         back_by     = excluded.back_by,
         version     = excluded.version,
         updated_at  = excluded.updated_at,
         actor_id    = excluded.actor_id,
         actor_name  = excluded.actor_name,
         actor_role  = excluded.actor_role,
         source      = excluded.source,
         confirm_requested_at = NULL,
         confirm_requested_by = NULL`,
      input.roomId,
      input.locationId,
      note,
      backBy,
      version,
      at,
      input.actor.id,
      input.actor.name,
      input.actor.role,
      input.source,
    );

    run(
      `INSERT INTO status_events (id, room_id, from_location_id, to_location_id, note, back_by,
                                  at, actor_id, actor_name, actor_role, source, version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId(),
      input.roomId,
      current?.location_id ?? null,
      input.locationId,
      note,
      backBy,
      at,
      input.actor.id,
      input.actor.name,
      input.actor.role,
      input.source,
      version,
    );

    return { status: 'ok', room: roomForStaff(input.roomId)!, repeated: false };
  });
}

/** Reception asks a room to confirm where it is. One tap instead of a phone call. */
export function requestConfirmation(roomId: string, actor: User): StaffRoom | null {
  const room = findRoom(roomId);
  if (!room || room.archived_at) return null;
  run(
    `INSERT INTO room_state (room_id, version, confirm_requested_at, confirm_requested_by)
     VALUES (?, 0, ?, ?)
     ON CONFLICT(room_id) DO UPDATE SET confirm_requested_at = excluded.confirm_requested_at,
                                        confirm_requested_by = excluded.confirm_requested_by`,
    roomId,
    nowIso(),
    actor.name,
    );
  return roomForStaff(roomId);
}

export function clearConfirmation(roomId: string): void {
  run('UPDATE room_state SET confirm_requested_at = NULL, confirm_requested_by = NULL WHERE room_id = ?', roomId);
}

/**
 * Start a new day with an empty board. Deliberately not a status change: no location is
 * being claimed, so nothing is appended to `status_events` — it goes in the audit log
 * instead, and every room reads as "not set".
 */
export function clearBoard(): number {
  return run(
    `UPDATE room_state SET location_id = NULL, note = NULL, back_by = NULL, updated_at = NULL,
                           actor_id = NULL, actor_name = NULL, actor_role = NULL, source = NULL,
                           confirm_requested_at = NULL, confirm_requested_by = NULL,
                           version = version + 1`,
  ).changes;
}

// -------------------------------------------------------------------- history

export interface HistoryRow {
  id: string;
  room_id: string;
  room_name: string;
  from_label: string | null;
  to_label: string;
  to_kind: LocationKind;
  note: string | null;
  at: string;
  actor_name: string;
  actor_role: string;
  source: string;
}

export function history(limit = 50, roomId?: string): HistoryRow[] {
  return many<HistoryRow>(
    `SELECT e.id, e.room_id, r.name AS room_name,
            lf.label AS from_label, lt.label AS to_label, lt.kind AS to_kind,
            e.note, e.at, e.actor_name, e.actor_role, e.source
       FROM status_events e
       JOIN rooms r      ON r.id = e.room_id
       LEFT JOIN locations lf ON lf.id = e.from_location_id
       JOIN locations lt ON lt.id = e.to_location_id
      ${roomId ? 'WHERE e.room_id = ?' : ''}
      ORDER BY e.at DESC, e.version DESC
      LIMIT ?`,
    ...(roomId ? [roomId] : []),
    Math.min(Math.max(limit, 1), 200),
  );
}

/** Counts for the admin overview. Every number here is a count of real rows. */
export function activitySummary(sinceIso: string): {
  changesSince: number;
  byLocation: Array<{ label: string; kind: string; rooms: number }>;
  busiestRoom: { room_name: string; changes: number } | null;
} {
  const changesSince =
    one<{ n: number }>('SELECT COUNT(*) AS n FROM status_events WHERE at >= ?', sinceIso)?.n ?? 0;

  const byLocation = many<{ label: string; kind: string; rooms: number }>(
    `SELECT l.label, l.kind, COUNT(s.room_id) AS rooms
       FROM locations l
       LEFT JOIN room_state s ON s.location_id = l.id
       LEFT JOIN rooms r      ON r.id = s.room_id AND r.archived_at IS NULL
      WHERE l.archived_at IS NULL
      GROUP BY l.id ORDER BY l.sort_order`,
  );

  const busiestRoom =
    one<{ room_name: string; changes: number }>(
      `SELECT r.name AS room_name, COUNT(*) AS changes
         FROM status_events e JOIN rooms r ON r.id = e.room_id
        WHERE e.at >= ? GROUP BY e.room_id ORDER BY changes DESC LIMIT 1`,
      sinceIso,
    ) ?? null;

  return { changesSince, byLocation, busiestRoom };
}

// ----------------------------------------------------------------- management

export function createRoom(input: { name: string; shortName?: string; ageGroup?: string | null; accent?: string }): Room {
  const id = newId();
  const maxOrder = one<{ n: number }>('SELECT COALESCE(MAX(sort_order), 0) AS n FROM rooms')?.n ?? 0;
  run(
    `INSERT INTO rooms (id, name, short_name, age_group, accent, sort_order, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    id,
    input.name.trim(),
    (input.shortName ?? input.name).trim(),
    input.ageGroup ?? null,
    input.accent ?? 'sky',
    maxOrder + 10,
    nowIso(),
  );
  run('INSERT INTO room_state (room_id, version) VALUES (?, 0)', id);
  return findRoom(id)!;
}

export function updateRoom(
  id: string,
  patch: { name?: string; shortName?: string; ageGroup?: string | null; accent?: string; sortOrder?: number },
): Room | null {
  const room = findRoom(id);
  if (!room) return null;
  run(
    `UPDATE rooms SET name = ?, short_name = ?, age_group = ?, accent = ?, sort_order = ? WHERE id = ?`,
    patch.name?.trim() ?? room.name,
    patch.shortName?.trim() ?? room.short_name,
    patch.ageGroup === undefined ? room.age_group : patch.ageGroup,
    patch.accent ?? room.accent,
    patch.sortOrder ?? room.sort_order,
    id,
  );
  return findRoom(id);
}

/** Archived, never deleted: the history of a closed room is still the centre's record. */
export function archiveRoom(id: string): boolean {
  return run('UPDATE rooms SET archived_at = ? WHERE id = ? AND archived_at IS NULL', nowIso(), id).changes > 0;
}

export function createLocation(input: { label: string; kind: LocationKind; icon?: string }): Location {
  const id = newId();
  const maxOrder = one<{ n: number }>('SELECT COALESCE(MAX(sort_order), 0) AS n FROM locations')?.n ?? 0;
  run(
    'INSERT INTO locations (id, label, kind, icon, sort_order) VALUES (?,?,?,?,?)',
    id,
    input.label.trim(),
    input.kind,
    input.icon ?? 'pin',
    maxOrder + 10,
  );
  return findLocation(id)!;
}

export function updateLocation(
  id: string,
  patch: { label?: string; kind?: LocationKind; icon?: string; sortOrder?: number },
): Location | null {
  const existing = findLocation(id);
  if (!existing) return null;
  run(
    'UPDATE locations SET label = ?, kind = ?, icon = ?, sort_order = ? WHERE id = ?',
    patch.label?.trim() ?? existing.label,
    patch.kind ?? existing.kind,
    patch.icon ?? existing.icon,
    patch.sortOrder ?? existing.sort_order,
    id,
  );
  return findLocation(id);
}

/** Refused while a room is still standing on it, which would blank that room's board. */
export function archiveLocation(id: string): { ok: boolean; inUseBy: number } {
  const inUse = one<{ n: number }>('SELECT COUNT(*) AS n FROM room_state WHERE location_id = ?', id)?.n ?? 0;
  if (inUse > 0) return { ok: false, inUseBy: inUse };
  const changed = run('UPDATE locations SET archived_at = ? WHERE id = ? AND archived_at IS NULL', nowIso(), id)
    .changes;
  return { ok: changed > 0, inUseBy: 0 };
}

/**
 * Demo-only: push a room's last update into the past so the staleness warning can be
 * shown in a meeting without waiting 45 minutes. It writes a real timestamp — the
 * warning that appears is the real code path, not a mock.
 */
export function simulateStale(roomId: string, minutesAgo: number): StaffRoom | null {
  const room = findRoom(roomId);
  if (!room) return null;
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  run('UPDATE room_state SET updated_at = ? WHERE room_id = ? AND location_id IS NOT NULL', at, roomId);
  run('UPDATE status_events SET at = ? WHERE room_id = ? AND at = (SELECT MAX(at) FROM status_events WHERE room_id = ?)',
    at, roomId, roomId);
  return roomForStaff(roomId);
}
