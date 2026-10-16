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
 * Authentication and permissions.
 *
 * Two credentials, because the two devices are not alike:
 *
 *   password  — reception and administrators, on a shared computer. Email + password.
 *   PIN       — educators, on a tablet held in one hand while watching children. Four
 *               digits, no keyboard, no email address to type.
 *
 * A four-digit PIN is a weak secret in the abstract. It is used here behind three
 * things that make it reasonable: the tablet is physically inside a licensed facility,
 * every attempt is scrypt-hashed (so guessing is expensive per try), and the attempt is
 * rate-limited per room and per address with exponential backoff. What a PIN protects is
 * the *attribution* of a status change, not children's records — there are none in this
 * database.
 *
 * Note what the sign-in screen does NOT do: it never lists staff names. An unauthenticated
 * visitor who finds the URL sees a list of rooms, nothing more. The server identifies the
 * educator from (room, PIN), so no personal information leaves the server before someone
 * has proved who they are.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { many, one, run } from './db.ts';
import { newId, newToken, nowIso, sha256 } from './util.ts';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
const SESSION_DAYS = 14;

export type Role = 'admin' | 'reception' | 'teacher';

export interface User {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  status: 'active' | 'suspended';
  is_demo: number;
  created_at: string;
  last_login_at: string | null;
}

/** Columns that may leave this module. Written out because `u.*` would one day ship a
 *  password hash to a browser, and a type annotation cannot stop SQL from doing that. */
const USER_COLUMNS = 'u.id, u.name, u.email, u.role, u.status, u.is_demo, u.created_at, u.last_login_at';

// ------------------------------------------------------------------- secrets

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(secret, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifySecret(secret: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, keyHex] = parts;
  try {
    const salt = Buffer.from(saltHex!, 'hex');
    const expected = Buffer.from(keyHex!, 'hex');
    const actual = scryptSync(secret, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** A decoy hash so a missing account and a wrong secret take the same time. */
const DECOY = hashSecret('decoy-value-never-matches');
const burnTime = (secret: string): void => void verifySecret(secret, DECOY);

// ------------------------------------------------------------------ sessions

export interface Session {
  token: string;
  csrf: string;
  expiresAt: string;
  user: User;
}

function startSession(user: User, userAgent: string | null): Session {
  const token = newToken();
  const csrf = newToken(18);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  run(
    `INSERT INTO sessions (id, user_id, token_hash, csrf, created_at, expires_at, user_agent)
     VALUES (?,?,?,?,?,?,?)`,
    newId(),
    user.id,
    sha256(token),
    csrf,
    nowIso(),
    expiresAt,
    userAgent,
  );
  run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
  return { token, csrf, expiresAt, user };
}

export function loginWithPassword(email: string, password: string, userAgent: string | null): Session | null {
  const row = one<User & { password_hash: string | null }>(
    `SELECT id, name, email, role, status, is_demo, created_at, last_login_at, password_hash
       FROM users WHERE email = ? AND status = 'active'`,
    email.trim().toLowerCase(),
  );
  if (!row) {
    burnTime(password);
    return null;
  }
  if (!verifySecret(password, row.password_hash)) return null;
  const { password_hash: _drop, ...user } = row;
  return startSession(user as User, userAgent);
}

/**
 * PIN sign-in, scoped to a room. Only educators assigned to that room are considered,
 * which keeps the search space tiny and means a PIN learned in one room is useless in
 * another.
 */
export function loginWithPin(roomId: string, pin: string, userAgent: string | null): Session | null {
  const candidates = many<User & { pin_hash: string | null }>(
    `SELECT ${USER_COLUMNS}, u.pin_hash
       FROM users u JOIN user_rooms ur ON ur.user_id = u.id
      WHERE ur.room_id = ? AND u.status = 'active' AND u.pin_hash IS NOT NULL
      ORDER BY u.name`,
    roomId,
  );
  for (const candidate of candidates) {
    if (verifySecret(pin, candidate.pin_hash)) {
      const { pin_hash: _drop, ...user } = candidate;
      return startSession(user as User, userAgent);
    }
  }
  burnTime(pin);
  return null;
}

export interface Authenticated {
  user: User;
  csrf: string;
  sessionId: string;
}

export function sessionForToken(token: string | null | undefined): Authenticated | null {
  if (!token) return null;
  const row = one<User & { csrf: string; session_id: string }>(
    `SELECT ${USER_COLUMNS}, s.csrf, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'`,
    sha256(token),
    nowIso(),
  );
  if (!row) return null;
  const { csrf, session_id: sessionId, ...user } = row;
  return { user: user as User, csrf, sessionId };
}

export function logout(token: string): void {
  run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', nowIso(), sha256(token));
}

export function revokeSessionsFor(userId: string): number {
  return run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', nowIso(), userId).changes;
}

// --------------------------------------------------------------- permissions

export const CAPABILITIES = [
  /** See the staff board: notes, who changed what, connection state. */
  'board:read:staff',
  /** Change the status of a room this user is assigned to. */
  'status:write:assigned',
  /** Change any room's status — the supervisor override. */
  'status:write:any',
  /** Ask a room to confirm where it is, without phoning it. */
  'status:confirm:request',
  'rooms:manage',
  'locations:manage',
  'staff:manage',
  'display:manage',
  'audit:read',
  'settings:manage',
  'demo:reset',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  teacher: ['board:read:staff', 'status:write:assigned'],

  // Reception can see everything on the staff board and can ask a room to confirm, but
  // cannot set a location. The front desk cannot see the playground; letting it write a
  // location would let it record a guess as an observation. (See ADR, "what changed".)
  reception: ['board:read:staff', 'status:confirm:request'],

  admin: [...CAPABILITIES],
};

export function can(user: User | null, capability: Capability): boolean {
  if (!user || user.status !== 'active') return false;
  return ROLE_CAPABILITIES[user.role].includes(capability);
}

export function capabilitiesFor(user: User | null): Capability[] {
  return user ? [...ROLE_CAPABILITIES[user.role]] : [];
}

/** Rooms this user may change. Admins may change any, so this returns null meaning "all". */
export function assignedRoomIds(user: User): string[] {
  return many<{ room_id: string }>('SELECT room_id FROM user_rooms WHERE user_id = ?', user.id).map(
    (r) => r.room_id,
  );
}

export function mayWriteRoom(user: User, roomId: string): boolean {
  if (can(user, 'status:write:any')) return true;
  if (!can(user, 'status:write:assigned')) return false;
  return assignedRoomIds(user).includes(roomId);
}

// -------------------------------------------------------------------- people

export interface NewStaff {
  name: string;
  email?: string | null;
  role: Role;
  password?: string | null;
  pin?: string | null;
  roomIds?: string[];
  isDemo?: boolean;
}

export function createStaff(input: NewStaff): User {
  const id = newId();
  run(
    `INSERT INTO users (id, name, email, role, password_hash, pin_hash, status, is_demo, created_at)
     VALUES (?,?,?,?,?,?,'active',?,?)`,
    id,
    input.name.trim(),
    input.email ? input.email.trim().toLowerCase() : null,
    input.role,
    input.password ? hashSecret(input.password) : null,
    input.pin ? hashSecret(input.pin) : null,
    input.isDemo ? 1 : 0,
    nowIso(),
  );
  for (const roomId of input.roomIds ?? []) {
    run('INSERT OR IGNORE INTO user_rooms (user_id, room_id) VALUES (?,?)', id, roomId);
  }
  return one<User>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`, id)!;
}

export function listStaff(): Array<User & { rooms: string[]; has_pin: number; has_password: number }> {
  const rows = many<User & { has_pin: number; has_password: number }>(
    `SELECT ${USER_COLUMNS},
            CASE WHEN u.pin_hash IS NULL THEN 0 ELSE 1 END      AS has_pin,
            CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END AS has_password
       FROM users u ORDER BY u.role, u.name`,
  );
  return rows.map((row) => ({
    ...row,
    rooms: many<{ room_id: string }>('SELECT room_id FROM user_rooms WHERE user_id = ?', row.id).map(
      (r) => r.room_id,
    ),
  }));
}

export function findStaff(id: string): User | null {
  return one<User>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`, id);
}

export function setStaffStatus(id: string, status: 'active' | 'suspended'): boolean {
  const changed = run('UPDATE users SET status = ? WHERE id = ?', status, id).changes > 0;
  if (changed && status === 'suspended') revokeSessionsFor(id);
  return changed;
}

export function setStaffPin(id: string, pin: string): boolean {
  const changed = run('UPDATE users SET pin_hash = ?, is_demo = 0 WHERE id = ?', hashSecret(pin), id).changes > 0;
  if (changed) revokeSessionsFor(id);
  return changed;
}

export function setStaffPassword(id: string, password: string): boolean {
  const changed =
    run('UPDATE users SET password_hash = ?, is_demo = 0 WHERE id = ?', hashSecret(password), id).changes > 0;
  if (changed) revokeSessionsFor(id);
  return changed;
}

export function setStaffRooms(id: string, roomIds: string[]): void {
  run('DELETE FROM user_rooms WHERE user_id = ?', id);
  for (const roomId of roomIds) {
    run('INSERT OR IGNORE INTO user_rooms (user_id, room_id) VALUES (?,?)', id, roomId);
  }
}

/** Used by the production-mode boot guard: seeded credentials must be gone before go-live. */
export function demoCredentialCount(): number {
  return one<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE is_demo = 1")?.n ?? 0;
}
