"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";

interface Win98AlertProps {
  kind: "success" | "error";
  title: string;
  message: string;
  onOk: () => void;
}

/** Classic Win98 message-box used for transaction outcomes. */
export function Win98Alert({ kind, title, message, onOk }: Win98AlertProps) {
  return (
    <div className="absolute inset-0 z-[300] flex items-center justify-center bg-black/30 p-3">
      <div className="win98-window bevel-out w-80">
        <div className="win98-titlebar">
          <span className="flex-1 text-[12px]">{title}</span>
        </div>
        <div className="flex items-start gap-3 p-3">
          {kind === "success" ? (
            <CircleCheck size={28} className="shrink-0 text-[#008000]" />
          ) : (
            <TriangleAlert size={28} className="shrink-0 text-[#800000]" />
          )}
          <div className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs leading-snug">
            {message}
          </div>
        </div>
        <div className="flex justify-center pb-3">
          <button type="button" className="win98-button" onClick={onOk}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
