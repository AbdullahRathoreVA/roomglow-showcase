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
 * Who may do what, and what the lobby TV is allowed to be told.
 *
 * The kiosk payload test is the one that would have caught the worst possible bug in this
 * product: a child's room note or an educator's name appearing on a screen in a public
 * reception area.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb } from '../src/core/db.ts';
import { openSeededDb } from './helpers.ts';
import {
  can,
  capabilitiesFor,
  demoCredentialCount,
  findStaff,
  hashSecret,
  loginWithPin,
  mayWriteRoom,
  setStaffPin,
  verifySecret,
} from '../src/core/auth.ts';
import { buildBoard, setStatus } from '../src/core/rooms.ts';

let temp: { cleanup: () => void };
before(() => { temp = openSeededDb(); });
after(() => { closeDb(); temp.cleanup(); });

describe('capabilities', () => {
  it('gives an educator exactly two', () => {
    assert.deepEqual(capabilitiesFor(findStaff('usr-dawn')), ['board:read:staff', 'status:write:assigned']);
  });

  it('lets reception read and ask, never write a location', () => {
    const desk = findStaff('usr-desk')!;
    assert.equal(can(desk, 'board:read:staff'), true);
    assert.equal(can(desk, 'status:confirm:request'), true);
    assert.equal(can(desk, 'status:write:assigned'), false);
    assert.equal(can(desk, 'status:write:any'), false);
    assert.equal(mayWriteRoom(desk, 'room-rainbow'), false);
  });

  it('scopes an educator to their own rooms', () => {
    const dawn = findStaff('usr-dawn')!;
    assert.equal(mayWriteRoom(dawn, 'room-rainbow'), true);
    assert.equal(mayWriteRoom(dawn, 'room-blue'), false);
  });

  it('lets a float educator cover several rooms', () => {
    const sam = findStaff('usr-sam')!;
    assert.equal(mayWriteRoom(sam, 'room-acorn'), true);
    assert.equal(mayWriteRoom(sam, 'room-rainbow'), true);
    assert.equal(mayWriteRoom(sam, 'room-blue'), false);
  });

  it('gives an administrator every capability, including any room', () => {
    const director = findStaff('usr-director')!;
    assert.equal(can(director, 'status:write:any'), true);
    assert.equal(mayWriteRoom(director, 'room-blue'), true);
    assert.equal(can(director, 'demo:reset'), true);
  });

  it('gives a suspended account nothing', () => {
    const suspended = { ...findStaff('usr-dawn')!, status: 'suspended' as const };
    assert.equal(can(suspended, 'status:write:assigned'), false);
  });

  it('gives an absent user nothing', () => {
    assert.equal(can(null, 'board:read:staff'), false);
    assert.deepEqual(capabilitiesFor(null), []);
  });
});

describe('what the lobby TV is told', () => {
  before(() => {
    // Put a note and a named author on a room, so there is something to leak.
    setStatus({
      roomId: 'room-sunshine',
      locationId: 'loc-outside',
      note: 'Ada is staying inside with Priya today',
      version: null,
      actor: findStaff('usr-priya')!,
      source: 'teacher',
    });
  });

  it('has no note, no author and no version anywhere in the payload', () => {
    const kiosk = buildBoard('kiosk');
    const serialised = JSON.stringify(kiosk);

    assert.doesNotMatch(serialised, /Ada is staying inside/, 'a staff note reached the kiosk payload');
    assert.doesNotMatch(serialised, /Priya/, 'an educator name reached the kiosk payload');
    assert.doesNotMatch(serialised, /"note"/, 'the kiosk payload has a note field at all');
    assert.doesNotMatch(serialised, /"actorName"/);
    assert.doesNotMatch(serialised, /"connectedDevices"/);
    assert.doesNotMatch(serialised, /confirmRequested/);
  });

  it('still tells the TV what it needs: place, age group, and how old the claim is', () => {
    const room = buildBoard('kiosk').rooms.find((entry) => entry.id === 'room-sunshine')!;
    assert.equal(room.location, 'Outside Play Area');
    assert.equal(room.ageGroup, '18 months – 3 years');
    assert.equal(room.freshness, 'fresh');
    assert.equal(typeof room.minutesSince, 'number');
  });

  it('gives the staff board the fields the TV does not get', () => {
    const room = buildBoard('staff').rooms.find((entry) => entry.id === 'room-sunshine')!;
    assert.match(JSON.stringify(room), /Ada is staying inside/);
    assert.equal((room as { actorName?: string }).actorName, 'Priya Raman');
  });
});

describe('credentials', () => {
  it('hashes with a per-call salt and verifies', () => {
    const first = hashSecret('1042');
    const second = hashSecret('1042');
    assert.notEqual(first, second, 'same PIN must not produce the same hash');
    assert.equal(verifySecret('1042', first), true);
    assert.equal(verifySecret('1043', first), false);
    assert.equal(verifySecret('1042', null), false);
    assert.equal(verifySecret('1042', 'not-a-hash'), false);
  });

  it('accepts a PIN only for a room that educator is assigned to', () => {
    assert.ok(loginWithPin('room-rainbow', '1042', null), 'Dawn should sign in to Rainbow');
    assert.equal(loginWithPin('room-blue', '1042', null), null, "Dawn's PIN must not work in Blue Room");
    assert.equal(loginWithPin('room-rainbow', '9999', null), null);
  });

  it('counts seeded accounts so production mode can refuse to start', () => {
    assert.equal(demoCredentialCount(), 8);
    setStaffPin('usr-dawn', '7777');
    assert.equal(demoCredentialCount(), 7, 'changing a credential clears the demo flag');
    assert.ok(loginWithPin('room-rainbow', '7777', null));
  });
});
