/*
 * The largest Markdown document Markbeam promises to persist safely.
 *
 * File opening and image insertion share this value so a document cannot enter through one
 * path after the other has refused it. The limit is measured in UTF-8 bytes: File.size uses
 * bytes already, while editor text needs encoding before it can be compared.
 */

export const MAX_DOCUMENT_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

export const documentBytes = (text) => encoder.encode(String(text || '')).byteLength;
