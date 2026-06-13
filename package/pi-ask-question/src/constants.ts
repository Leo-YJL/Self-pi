export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

export const RESERVED_LABELS = new Set([
  "other",
  "type something.",
  "chat about this",
  "next →",
  "next ->",
  "submit",
]);

export const DECLINE_MESSAGE = "User declined to answer questions";
export const CHAT_CONTINUATION_MESSAGE = "User wants to chat about this. Continue the conversation to help them decide.";
