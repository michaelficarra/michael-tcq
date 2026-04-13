/**
 * Type declaration for the firestore-store package.
 * It doesn't ship its own types.
 */
declare module 'firestore-store' {
  import type { Store } from 'express-session';
  import type { Firestore } from '@google-cloud/firestore';

  interface FirestoreStoreOptions {
    /** The Firestore database instance. */
    dataset: Firestore;
    /** The collection name to store sessions in. */
    kind: string;
  }

  export class FirestoreStore extends Store {
    constructor(options: FirestoreStoreOptions);
  }
}
