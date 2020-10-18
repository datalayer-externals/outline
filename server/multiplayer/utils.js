// @flow
import * as decoding from "lib0/dist/decoding.cjs";
import * as encoding from "lib0/dist/encoding.cjs";
import { debounce } from "lodash";
import { Socket } from "socket.io-client";
import * as awarenessProtocol from "y-protocols/dist/awareness.cjs";
import * as syncProtocol from "y-protocols/dist/sync.cjs";
import * as Y from "yjs";
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from "../../shared/constants";
import { Document } from "../models";
import WSSharedDoc from "./WSSharedDoc";

const docs = new Map();

const messageListener = (conn: Socket, doc, message) => {
  if (!doc) return;

  const encoder = encoding.createEncoder();
  const decoder = decoding.createDecoder(message);
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case MESSAGE_SYNC:
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, null);
      if (encoding.length(encoder) > 1) {
        conn.binary(true).emit("document.sync", {
          documentId: doc.documentId,
          data: encoding.toUint8Array(encoder),
        });
      }
      break;
    case MESSAGE_AWARENESS: {
      console.log("applying awareness update");
      awarenessProtocol.applyAwarenessUpdate(
        doc.awareness,
        decoding.readVarUint8Array(decoder),
        conn
      );
      break;
    }
    default:
  }
};

const cleanup = async (doc, conn) => {
  if (!doc || !doc.conns.has(conn)) {
    return;
  }
  const controlledIds = doc.conns.get(conn);
  doc.conns.delete(conn);

  awarenessProtocol.removeAwarenessStates(
    doc.awareness,
    Array.from(controlledIds),
    null
  );

  // last person has left this editing session
  if (doc.conns.size === 0) {
    console.log("everyone left, writing to database…");
    // TODO: write a revision

    const state = Y.encodeStateAsUpdate(doc);
    await Document.update(
      {
        state: Buffer.from(state),
        updatedAt: new Date(),
      },
      {
        hooks: false,
        where: {
          id: doc.documentId,
        },
      }
    );

    doc.destroy();
    docs.delete(doc.documentId);
  }
};

const PERSIST_WAIT = 3000;

export const setupConnection = async (conn: Socket, document: Document) => {
  const documentId = document.id;
  console.log("setupConnection", documentId);

  let doc: ?WSSharedDoc = docs.get(documentId);

  if (!doc) {
    doc = new WSSharedDoc(documentId);
    doc.get("prosemirror", Y.XmlFragment);

    if (document.state) {
      console.log("new session, stated loaded from db");
      Y.applyUpdate(doc, document.state);
    } else {
      console.log("new session, no existing state");
    }

    doc.on(
      "update",
      debounce(
        async (update) => {
          console.log("saving update…");
          Y.applyUpdate(doc, update);
          const state = Y.encodeStateAsUpdate(doc);
          await Document.update(
            {
              state: Buffer.from(state),
              updatedAt: new Date(),
            },
            {
              hooks: false,
              where: {
                id: documentId,
              },
            }
          );
        },
        PERSIST_WAIT,
        {
          maxWait: PERSIST_WAIT * 3,
        }
      )
    );

    docs.set(documentId, doc);
  }

  doc.conns.set(conn, new Set());

  // listen and reply to events
  conn.on("sync", (event) => {
    if (event.documentId === documentId) {
      messageListener(conn, doc, new Uint8Array(event.data));
    }
  });

  conn.on("disconnecting", () => cleanup(doc, conn));
  conn.on("leave", (event) => {
    if (event.documentId === documentId) {
      cleanup(doc, conn);
    }
  });

  // send sync step 1
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);

  conn.binary(true).emit("document.sync", {
    documentId: doc.documentId,
    data: encoding.toUint8Array(encoder),
  });

  const awarenessStates = doc.awareness.getStates();

  if (awarenessStates.size > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        doc.awareness,
        Array.from(awarenessStates.keys())
      )
    );

    conn.binary(true).emit("document.sync", {
      documentId: doc.documentId,
      data: encoding.toUint8Array(encoder),
    });
  }
};
