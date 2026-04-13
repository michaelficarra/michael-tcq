/**
 * Firestore-backed meeting store for production.
 *
 * Each meeting is stored as a document in a "meetings" collection,
 * keyed by the meeting ID. The document body is the full serialised
 * MeetingState.
 *
 * Used when STORE=firestore is set in the environment. Requires a
 * GCP project with Firestore enabled. In production (Cloud Run), the
 * default service account has access automatically. For local dev,
 * set GOOGLE_APPLICATION_CREDENTIALS to a service account key file.
 */

import { Firestore } from '@google-cloud/firestore';
import type { MeetingState } from '@tcq/shared';
import type { MeetingStore } from './store.js';

/** The Firestore collection name for meeting documents. */
const MEETINGS_COLLECTION = 'meetings';

export class FirestoreMeetingStore implements MeetingStore {
  private db: Firestore;

  constructor(options?: ConstructorParameters<typeof Firestore>[0]) {
    // The Firestore client auto-discovers credentials from:
    // - GOOGLE_APPLICATION_CREDENTIALS env var (local dev)
    // - Default service account (Cloud Run)
    // Options can include databaseId for named databases.
    this.db = new Firestore(options);
  }

  /** Persist a meeting's current state as a Firestore document. */
  async save(meeting: MeetingState): Promise<void> {
    const docRef = this.db.collection(MEETINGS_COLLECTION).doc(meeting.id);
    // Use set() to create or overwrite the entire document.
    // Firestore doesn't natively handle undefined values, so we
    // serialise via JSON to strip them out.
    const data = JSON.parse(JSON.stringify(meeting));
    await docRef.set(data);
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

  /** Remove a meeting from the persistent store. */
  async remove(meetingId: string): Promise<void> {
    const docRef = this.db.collection(MEETINGS_COLLECTION).doc(meetingId);
    await docRef.delete();
  }
}
