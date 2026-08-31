// Shared, framework-agnostic types for Board.exe's "document sale" — a
// separate, simpler ad product from the pixel board. Pure (no "use client"),
// imported by both the client store and the server route.

export const DOCUMENT_PRICE_SOL = 0.2;

export const DOCUMENT_NAME_MAX_LEN = 100;
export const DOCUMENT_CONTENT_MAX_LEN = 5000;

export interface DocumentData {
  id: string;
  name: string;
  content: string;
  owner: string; // wallet public key (base58)
  purchasedAt: number;
}

export interface DocumentValidationError {
  field: string;
  reason: string;
}

export function sanitizeDocumentInput(
  nameInput: unknown,
  contentInput: unknown
): { name: string; content: string } | DocumentValidationError {
  const name = typeof nameInput === "string" ? nameInput.trim() : "";
  const content = typeof contentInput === "string" ? contentInput : "";
  if (name.length > DOCUMENT_NAME_MAX_LEN) {
    return { field: "name", reason: `must be at most ${DOCUMENT_NAME_MAX_LEN} characters` };
  }
  if (content.length > DOCUMENT_CONTENT_MAX_LEN) {
    return { field: "content", reason: `must be at most ${DOCUMENT_CONTENT_MAX_LEN} characters` };
  }
  return { name: name || "Untitled", content };
}

export function isDocumentValidationError(
  value: { name: string; content: string } | DocumentValidationError
): value is DocumentValidationError {
  return "reason" in value;
}
