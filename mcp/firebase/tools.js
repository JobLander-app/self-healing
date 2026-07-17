import { z } from "zod";
import admin from "firebase-admin";
import { Buffer } from "buffer";

const CHARACTER_LIMIT = 200000;

let db, auth;

export function initFirebase() {
  if (admin.apps.length > 0) return;

  const projectId =
    (process.env.GCP_PROJECT_ID || "meet-assistant-6d8ad").trim();
  const keyB64 = (process.env.GCP_PRIVATE_KEY_BASE_64 || "").trim();

  if (keyB64) {
    // Cert path (dev / back-compat): an explicit service-account key is
    // supplied via Secret Manager. Trim whitespace — Secret Manager values
    // may carry trailing newlines.
    const privateKey = Buffer.from(keyB64, "base64").toString("utf8");
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail: (process.env.GCP_CLIENT_EMAIL || "").trim(),
        privateKey,
      }),
    });
  } else {
    // ADC path (prod default on the self-healing VM): no key file. The VM's
    // attached service account provides credentials via Application Default
    // Credentials — needs only roles/datastore.viewer for the read tools
    // (granted separately in terraform). Write tools fail-closed without
    // write perms, which is the intended posture for an investigation session.
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId,
    });
  }

  db = admin.firestore();
  auth = admin.auth();
}

// ── Shared utilities ─────────────────────────────────────

function handleError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  // Sanitize: never expose keys, tokens, or internal paths
  const sanitized = msg
    .replace(/-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g, "[key]")
    .replace(/\/home\/[^\s]*/g, "[path]")
    .replace(/\/app\/[^\s]*/g, "[path]")
    .replace(/[A-Za-z0-9+/=]{40,}/g, "[credential]");
  return {
    content: [{ type: "text", text: `Error: ${sanitized}` }],
    isError: true,
  };
}

function truncateResponse(text) {
  if (text.length <= CHARACTER_LIMIT) return text;
  // IMPORTANT: never append raw text to a sliced JSON string — that produces
  // invalid JSON (raw \n inside a string literal) that breaks JSON.parse().
  // Instead return a well-formed JSON error object that callers can detect.
  return JSON.stringify({
    error: "response_truncated",
    message: `Result (${text.length} chars) exceeds the ${CHARACTER_LIMIT}-char limit. ` +
      "Add a smaller 'limit' parameter or narrow the date range to reduce result size.",
  });
}

function jsonResponse(data) {
  return {
    content: [{ type: "text", text: truncateResponse(JSON.stringify(data, null, 2)) }],
  };
}

// ── Tool registration ────────────────────────────────────

export function registerTools(server) {
  initFirebase();
  db = admin.firestore();
  auth = admin.auth();

  // ── firestore_get_document ──────────────────────────────

  server.registerTool(
    "firestore_get_document",
    {
      title: "Get Firestore Document",
      description: `Get a Firestore document by its full path.

Args:
  - path (string, required): Document path in Firestore (e.g. 'users/abc123', 'sessions/xyz/messages/msg1').

Returns:
  { "id": string, "path": string, "data": object }
  If not found: { "exists": false, "path": string }

Examples:
  - Get user: { "path": "users/abc123" }
  - Get nested doc: { "path": "sessions/xyz/messages/msg1" }

Error Handling:
  - "NOT_FOUND" — document does not exist at the given path.
  - Invalid path (odd number of segments) — Firestore requires collection/document pairs.`,
      inputSchema: {
        path: z.string().min(1, "Document path cannot be empty").describe("Document path in Firestore (e.g. 'users/abc123')"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      try {
        const docRef = db.doc(path);
        const snap = await docRef.get();
        if (!snap.exists) {
          return jsonResponse({ exists: false, path });
        }
        return jsonResponse({ id: snap.id, path: snap.ref.path, data: snap.data() });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── firestore_list_documents ────────────────────────────

  server.registerTool(
    "firestore_list_documents",
    {
      title: "List Firestore Documents",
      description: `List documents in a Firestore collection with optional limit.

Args:
  - collection (string, required): Collection path (e.g. 'users', 'sessions/xyz/messages').
  - limit (number, optional): Max number of documents to return. Default: 20. Max: 500.

Returns:
  { "collection": string, "count": number, "docs": [{ "id": string, "path": string, "data": object }] }

Examples:
  - List users: { "collection": "users" }
  - List with limit: { "collection": "users", "limit": 5 }

Error Handling:
  - Invalid collection path (even number of segments) — must point to a collection, not a document.`,
      inputSchema: {
        collection: z.string().min(1, "Collection path cannot be empty").describe("Collection path (e.g. 'users')"),
        limit: z.coerce.number().int().min(1).max(500).default(20).describe("Max number of documents to return"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ collection, limit }) => {
      try {
        const colRef = db.collection(collection);
        const snap = await colRef.limit(limit).get();
        const docs = snap.docs.map((doc) => ({
          id: doc.id,
          path: doc.ref.path,
          data: doc.data(),
        }));
        return jsonResponse({ collection, count: docs.length, docs });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── firestore_query_collection ──────────────────────────

  server.registerTool(
    "firestore_query_collection",
    {
      title: "Query Firestore Collection",
      description: `Query a Firestore collection with where/orderBy/limit filters.

Args:
  - collection (string, required): Collection path (e.g. 'users').
  - where (array, optional): Array of filter conditions: [{ "field": string, "op": string, "value": any }].
    Supported operators: '==', '!=', '<', '<=', '>', '>=', 'in', 'array-contains'.
  - orderBy (object, optional): Order results — { "field": string, "direction": "asc" | "desc" }.
  - limit (number, optional): Max documents to return. Default: 20. Max: 500.

Returns:
  { "collection": string, "count": number, "docs": [{ "id": string, "path": string, "data": object }] }

Examples:
  - Filter by status: { "collection": "users", "where": [{ "field": "status", "op": "==", "value": "active" }] }
  - Order + limit: { "collection": "sessions", "orderBy": { "field": "createdAt", "direction": "desc" }, "limit": 10 }

Error Handling:
  - Composite index required — Firestore may require a composite index for certain where + orderBy combinations.
  - 'in' operator value must be an array with max 30 elements.`,
      inputSchema: {
        collection: z.string().min(1).describe("Collection path (e.g. 'users')"),
        where: z.array(z.object({
          field: z.string().describe("Field name to filter on"),
          op: z.string().describe("Comparison operator: ==, !=, <, <=, >, >=, in, array-contains"),
          value: z.any().describe("Value to compare against"),
        })).optional().describe("Array of filter conditions"),
        orderBy: z.object({
          field: z.string().describe("Field name to order by"),
          direction: z.enum(["asc", "desc"]).default("asc").describe("Sort direction"),
        }).optional().describe("Order results by field"),
        limit: z.coerce.number().int().min(1).max(500).default(20).describe("Max documents to return"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ collection, where, orderBy, limit }) => {
      try {
        let query = db.collection(collection);

        if (where && Array.isArray(where)) {
          for (const condition of where) {
            query = query.where(condition.field, condition.op, condition.value);
          }
        }

        if (orderBy) {
          query = query.orderBy(orderBy.field, orderBy.direction || "asc");
        }

        query = query.limit(limit);
        const snap = await query.get();
        const docs = snap.docs.map((doc) => ({
          id: doc.id,
          path: doc.ref.path,
          data: doc.data(),
        }));
        return jsonResponse({ collection, count: docs.length, docs });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── firestore_list_collections ──────────────────────────

  server.registerTool(
    "firestore_list_collections",
    {
      title: "List Root Collections",
      description: `List all root-level collections in Firestore.

Returns:
  { "collections": [string] }

Examples:
  - List all: {} (no arguments needed)

Error Handling:
  - Permission denied — service account needs Firestore read access.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const collections = await db.listCollections();
        const names = collections.map((col) => col.id);
        return jsonResponse({ collections: names });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── firestore_create_document ───────────────────────────

  server.registerTool(
    "firestore_create_document",
    {
      title: "Create Firestore Document",
      description: `Create a new Firestore document. Optionally specify a document ID, otherwise one is auto-generated.

Args:
  - collection (string, required): Collection path (e.g. 'users').
  - data (object, required): Document data as a JSON object.
  - documentId (string, optional): Document ID. If omitted, Firestore auto-generates one.

Returns:
  { "created": true, "id": string, "path": string }

Examples:
  - Auto ID: { "collection": "users", "data": { "name": "Alice", "role": "admin" } }
  - Custom ID: { "collection": "users", "documentId": "alice-1", "data": { "name": "Alice" } }

Error Handling:
  - Document already exists (with custom ID) — use firestore_update_document to update instead.`,
      inputSchema: {
        collection: z.string().min(1).describe("Collection path (e.g. 'users')"),
        data: z.record(z.any()).describe("Document data as a JSON object"),
        documentId: z.string().optional().describe("Optional document ID. If omitted, Firestore auto-generates one."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ collection, data, documentId }) => {
      try {
        const colRef = db.collection(collection);
        let docRef;
        if (documentId) {
          docRef = colRef.doc(documentId);
          await docRef.set(data);
        } else {
          docRef = await colRef.add(data);
        }
        return jsonResponse({ created: true, id: docRef.id, path: docRef.path });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── firestore_update_document ───────────────────────────

  server.registerTool(
    "firestore_update_document",
    {
      title: "Update Firestore Document",
      description: `Update fields in an existing Firestore document (merge mode — only specified fields are overwritten, others are preserved).

Args:
  - path (string, required): Document path in Firestore (e.g. 'users/abc123').
  - data (object, required): Fields to update as a JSON object.

Returns:
  { "updated": true, "path": string }

Examples:
  - Update email: { "path": "users/abc123", "data": { "email": "new@example.com" } }
  - Update nested: { "path": "users/abc123", "data": { "profile.bio": "Hello" } }

Error Handling:
  - Document not found — merge mode creates the document if it doesn't exist.`,
      inputSchema: {
        path: z.string().min(1).describe("Document path in Firestore (e.g. 'users/abc123')"),
        data: z.record(z.any()).describe("Fields to update as a JSON object (merge mode)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, data }) => {
      try {
        const updateRef = db.doc(path);
        await updateRef.set(data, { merge: true });
        return jsonResponse({ updated: true, path });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── firestore_delete_document ───────────────────────────

  server.registerTool(
    "firestore_delete_document",
    {
      title: "Delete Firestore Document",
      description: `Delete a Firestore document by its path. This permanently removes the document.

Args:
  - path (string, required): Document path in Firestore (e.g. 'users/abc123').

Returns:
  { "deleted": true, "path": string }

Examples:
  - Delete user: { "path": "users/abc123" }

Error Handling:
  - Deleting a non-existent document succeeds silently (Firestore behavior).
  - Deleting a document does NOT delete its subcollections.`,
      inputSchema: {
        path: z.string().min(1).describe("Document path in Firestore (e.g. 'users/abc123')"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      try {
        const deleteRef = db.doc(path);
        await deleteRef.delete();
        return jsonResponse({ deleted: true, path });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── auth_get_user ───────────────────────────────────────

  server.registerTool(
    "auth_get_user",
    {
      title: "Get Firebase Auth User",
      description: `Get a Firebase Auth user by email or UID. At least one identifier must be provided.

Args:
  - email (string, optional): User email address.
  - uid (string, optional): Firebase user UID.

Returns:
  { "uid": string, "email": string, "displayName": string, "disabled": boolean, "emailVerified": boolean,
    "creationTime": string, "lastSignInTime": string, "providerData": array, "customClaims": object }

Examples:
  - By email: { "email": "user@example.com" }
  - By UID: { "uid": "abc123def456" }

Error Handling:
  - "auth/user-not-found" — no user with the given email or UID.
  - Must provide at least one of email or uid.`,
      inputSchema: {
        email: z.string().email().optional().describe("User email address"),
        uid: z.string().optional().describe("Firebase user UID"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ email, uid }) => {
      try {
        if (!email && !uid) {
          return {
            content: [{ type: "text", text: "Error: either email or uid must be provided" }],
            isError: true,
          };
        }

        const userRecord = uid
          ? await auth.getUser(uid)
          : await auth.getUserByEmail(email);

        const result = {
          uid: userRecord.uid,
          email: userRecord.email,
          displayName: userRecord.displayName,
          photoURL: userRecord.photoURL,
          disabled: userRecord.disabled,
          emailVerified: userRecord.emailVerified,
          creationTime: userRecord.metadata?.creationTime,
          lastSignInTime: userRecord.metadata?.lastSignInTime,
          providerData: userRecord.providerData?.map((p) => ({
            providerId: p.providerId,
            email: p.email,
            displayName: p.displayName,
          })),
          customClaims: userRecord.customClaims,
        };

        return jsonResponse(result);
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── auth_create_user ────────────────────────────────────

  server.registerTool(
    "auth_create_user",
    {
      title: "Create Firebase Auth User",
      description: `Create a new Firebase Auth user with email, password, and optional display name.

Args:
  - email (string, required): User email address.
  - password (string, required): User password (min 6 characters).
  - displayName (string, optional): User display name.

Returns:
  { "created": true, "uid": string, "email": string, "displayName": string }

Examples:
  - Basic: { "email": "user@example.com", "password": "securePass123" }
  - With name: { "email": "user@example.com", "password": "securePass123", "displayName": "Alice" }

Error Handling:
  - "auth/email-already-exists" — a user with this email already exists.
  - "auth/invalid-password" — password must be at least 6 characters.`,
      inputSchema: {
        email: z.string().email().describe("User email address"),
        password: z.string().min(6, "Password must be at least 6 characters").describe("User password"),
        displayName: z.string().optional().describe("User display name"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ email, password, displayName }) => {
      try {
        const createProps = { email, password };
        if (displayName) createProps.displayName = displayName;

        const newUser = await auth.createUser(createProps);
        return jsonResponse({
          created: true,
          uid: newUser.uid,
          email: newUser.email,
          displayName: newUser.displayName,
        });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── auth_update_user ────────────────────────────────────

  server.registerTool(
    "auth_update_user",
    {
      title: "Update Firebase Auth User",
      description: `Update properties of an existing Firebase Auth user by UID.

Args:
  - uid (string, required): Firebase user UID.
  - email (string, optional): New email address.
  - password (string, optional): New password (min 6 characters).
  - displayName (string, optional): New display name.
  - disabled (boolean, optional): Whether the user account is disabled.
  - emailVerified (boolean, optional): Whether the email is marked as verified.

Returns:
  { "updated": true, "uid": string, "email": string, "displayName": string, "disabled": boolean }

Examples:
  - Update email: { "uid": "abc123", "email": "new@example.com" }
  - Disable user: { "uid": "abc123", "disabled": true }

Error Handling:
  - "auth/user-not-found" — no user with the given UID.
  - "auth/email-already-exists" — another user already has this email.`,
      inputSchema: {
        uid: z.string().min(1).describe("Firebase user UID"),
        email: z.string().email().optional().describe("New email address"),
        password: z.string().min(6).optional().describe("New password (min 6 characters)"),
        displayName: z.string().optional().describe("New display name"),
        disabled: z.boolean().optional().describe("Whether the user account is disabled"),
        emailVerified: z.boolean().optional().describe("Whether the email is verified"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ uid, email, password, displayName, disabled, emailVerified }) => {
      try {
        const updateProps = {};
        if (email !== undefined) updateProps.email = email;
        if (password !== undefined) updateProps.password = password;
        if (displayName !== undefined) updateProps.displayName = displayName;
        if (disabled !== undefined) updateProps.disabled = disabled;
        if (emailVerified !== undefined) updateProps.emailVerified = emailVerified;

        const updatedUser = await auth.updateUser(uid, updateProps);
        return jsonResponse({
          updated: true,
          uid: updatedUser.uid,
          email: updatedUser.email,
          displayName: updatedUser.displayName,
          disabled: updatedUser.disabled,
        });
      } catch (error) {
        return handleError(error);
      }
    }
  );

  // ── auth_delete_user ────────────────────────────────────

  server.registerTool(
    "auth_delete_user",
    {
      title: "Delete Firebase Auth User",
      description: `Delete a Firebase Auth user by UID. This permanently removes the user account.

Args:
  - uid (string, required): Firebase user UID.

Returns:
  { "deleted": true, "uid": string }

Examples:
  - Delete user: { "uid": "abc123def456" }

Error Handling:
  - "auth/user-not-found" — no user with the given UID.
  - This action is irreversible. The user must re-register to regain access.`,
      inputSchema: {
        uid: z.string().min(1).describe("Firebase user UID"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ uid }) => {
      try {
        await auth.deleteUser(uid);
        return jsonResponse({ deleted: true, uid });
      } catch (error) {
        return handleError(error);
      }
    }
  );
}
