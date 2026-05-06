/**
 * Firestore-backed meeting store for production.
 *
 * Each meeting is stored as a document in a "meetings" collection,
 * keyed by the meeting ID. The document body is the serialised
 * MeetingState (which no longer contains the log — see below).
 *
 * The per-meeting log lives in a `log` subcollection under each
 * meeting document (`meetings/{id}/log/{entryId}`), one Firestore
 * document per LogEntry. This keeps log appends cheap (one small
 * write per entry, instead of rewriting the whole meeting doc) and
 * — critically — keeps the log out of every Socket.IO state broadcast.
 *
 * Used when STORE=firestore is set in the environment. Requires a
 * GCP project with Firestore enabled. In production (Cloud Run), the
 * default service account has access automatically. For local dev,
 * set GOOGLE_APPLICATION_CREDENTIALS to a service account key file.
 */

import { Firestore } from '@google-cloud/firestore';
import type { LogEntry, MeetingState } from '@tcq/shared';
import type { MeetingStore } from './store.js';

/** The Firestore collection name for meeting documents. */
const MEETINGS_COLLECTION = 'meetings';

/** Subcollection under each meeting doc that holds log entries. */
const LOG_SUBCOLLECTION = 'log';

/**
 * Internal field added to each persisted log doc to provide a stable
 * ordering. Append order is the canonical order — the entry's own
 * `timestamp` represents *when the event happened*, which can predate
 * the append (e.g. `topic-discussed` carries the speaker's startTime,
 * not the time the entry was logged), so we cannot order by it.
 */
const SEQ_FIELD = '_seq';

export class FirestoreMeetingStore implements MeetingStore {
  private db: Firestore;

  /**
   * Per-meeting counter tracking the next `_seq` to assign on append.
   * Primed by `loadAllLogs` on restore; otherwise starts at 0 for
   * freshly-created meetings (which by definition have no prior log
   * entries on disk). Mutations to this map are synchronous, so the
   * single-event-loop assumption keeps appendLog free of races even
   * without external locking.
   */
  private logSeqs = new Map<string, number>();

  constructor(options?: ConstructorParameters<typeof Firestore>[0]) {
    // The Firestore client auto-discovers credentials from:
    // - GOOGLE_APPLICATION_CREDENTIALS env var (local dev)
    // - Default service account (Cloud Run)
    // Options can include databaseId for named databases.
    // ignoreUndefinedProperties: MeetingState has many optional fields
    // (current.speaker, poll, operational.lastAdvancementBy, etc.). Without
    // this flag, Firestore rejects undefined values on write.
    this.db = new Firestore({ ignoreUndefinedProperties: true, ...options });
  }

  /** Persist a meeting's current state as a Firestore document. */
  async save(meeting: MeetingState): Promise<void> {
    const docRef = this.db.collection(MEETINGS_COLLECTION).doc(meeting.id);
    await docRef.set(meeting);
  }

  /** Load a single meeting by ID, or null if it doesn't exist. */
  async load(meetingId: string): Promise<MeetingState | null> {
    const docRef = this.db.collection(MEETINGS_COLLECTION).doc(meetingId);
    const doc = await docRef.get();
    if (!doc.exists) return null;
    return doc.data() as MeetingState;
  }

  /** Load all persisted meetings (used on server startup for recovery). */
  async loadAll(): Promise<MeetingState[]> {
    const snapshot = await this.db.collection(MEETINGS_COLLECTION).get();
    return snapshot.docs.map((doc) => doc.data() as MeetingState);
  }

  /**
   * Remove a meeting and all of its log entries from the persistent
   * store. The log subcollection is deleted entry-by-entry — Firestore
   * does not cascade subcollection deletes when a parent doc is removed.
   */
  async remove(meetingId: string): Promise<void> {
    const docRef = this.db.collection(MEETINGS_COLLECTION).doc(meetingId);
    const logSnapshot = await docRef.collection(LOG_SUBCOLLECTION).get();
    const batch = this.db.batch();
    for (const logDoc of logSnapshot.docs) {
      batch.delete(logDoc.ref);
    }
    batch.delete(docRef);
    await batch.commit();
    this.logSeqs.delete(meetingId);
  }

  async appendLog(meetingId: string, entry: LogEntry): Promise<void> {
    // `?? 0` is correct for both freshly-created meetings (no prior
    // entries) and meetings restored via loadAllLogs (counter primed).
    // The synchronous get/set pair before the await makes this race-free
    // under the single-event-loop guarantee.
    const seq = this.logSeqs.get(meetingId) ?? 0;
    this.logSeqs.set(meetingId, seq + 1);

    const docRef = this.db.collection(MEETINGS_COLLECTION).doc(meetingId).collection(LOG_SUBCOLLECTION).doc(entry.id);
    await docRef.set({ ...entry, [SEQ_FIELD]: seq });
  }

  async loadLog(meetingId: string): Promise<LogEntry[]> {
    const snapshot = await this.db
      .collection(MEETINGS_COLLECTION)
      .doc(meetingId)
      .collection(LOG_SUBCOLLECTION)
      .orderBy(SEQ_FIELD)
      .get();
    return snapshot.docs.map((doc) => stripSeq(doc.data()));
  }

  async loadAllLogs(): Promise<Map<string, LogEntry[]>> {
    const logs = new Map<string, LogEntry[]>();
    const meetingsSnapshot = await this.db.collection(MEETINGS_COLLECTION).get();
    for (const meetingDoc of meetingsSnapshot.docs) {
      const logSnapshot = await meetingDoc.ref.collection(LOG_SUBCOLLECTION).orderBy(SEQ_FIELD).get();
      const entries = logSnapshot.docs.map((doc) => stripSeq(doc.data()));
      logs.set(meetingDoc.id, entries);
      // Prime the per-meeting seq counter so the next appendLog picks
      // up where this load left off.
      this.logSeqs.set(meetingDoc.id, entries.length);
    }
    return logs;
  }
}

function stripSeq(data: FirebaseFirestore.DocumentData): LogEntry {
  const copy = { ...data };
  delete copy[SEQ_FIELD];
  return copy as LogEntry;
}
