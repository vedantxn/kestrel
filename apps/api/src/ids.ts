import {
  SessionId,
  idToUuid,
  newId,
  uuidToId,
  uuidv7,
} from "@kestrel/contracts";

/** Database ids are bare uuids; the public ones carry a prefix. These are the only conversions. */
export const newUuid = (): string => uuidv7();
export const publicSessionId = (uuid: string): SessionId =>
  uuidToId("ses", uuid) as SessionId;
export const publicEventId = (uuid: string): string => uuidToId("evt", uuid);

/** A session id from a path or body, or null if it cannot name a session. */
export function sessionUuid(id: string): string | null {
  return SessionId.safeParse(id).success ? idToUuid(id) : null;
}

export const newRequestId = (): string => newId("evt").replace(/^evt_/, "req_");
