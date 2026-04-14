/**
 * Type declaration for the firestore-store package.
 *
 * It uses the connect-style factory pattern: the default export is
 * a function that takes the express-session module and returns the
 * FirestoreStore class.
 */
declare module 'firestore-store' {
  import type { Store } from 'express-session';
  import type expressSession from 'express-session';
  import type { Firestore } from '@google-cloud/firestore';

  interface FirestoreStoreOptions {
    /** The Firestore database instance. */
    database: Firestore;
    /** The collection name to store sessions in. Defaults to 'sessions'. */
    collection?: string;
  }

  interface FirestoreStoreClass {
    new (options: FirestoreStoreOptions): Store;
  }

  /** Factory function: pass express-session to get the store class. */
  function firestoreStore(session: typeof expressSession): FirestoreStoreClass;

  export default firestoreStore;
}
