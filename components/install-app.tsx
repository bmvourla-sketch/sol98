"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

/**
 * Win98-styled "Install app" control. Listens for the browser's
 * `beforeinstallprompt` (Chrome/Edge desktop + Android) and, when present,
 * triggers the native install prompt on click. On iOS Safari — which never
 * fires `beforeinstallprompt` — it shows a short "Add to Home Screen" hint
 * instead. Once installed (`appinstalled`) it removes itself.
 */
export function InstallAppButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    setIsIOS(
      /iphone|ipad|ipod/i.test(navigator.userAgent) && !("MSStream" in window)
    );

    function onPrompt(event: Event) {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setDeferred(null);
      setInstalled(true);
    }
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  async function handleInstall() {
    if (!deferred) {
      setShowHint((s) => !s);
      return;
    }
    setShowHint(false);
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") {
      setDeferred(null);
      setInstalled(true);
    }
  }

  return (
    <span className="relative flex items-center">
      <button
        type="button"
        className="win98-taskbar-button !px-2"
        onClick={handleInstall}
        title={isIOS ? "Add SOL-98 to your Home Screen" : "Install SOL-98 as an app"}
        aria-label="Install app"
      >
        <Download size={13} />
        <span className="hidden sm:inline">Install</span>
      </button>
      {showHint && (
        <div className="win98-menu absolute bottom-[34px] right-0 z-[110] w-60 px-3 py-2 text-[11px] leading-snug">
          {isIOS
            ? "Tap the Share button, then “Add to Home Screen” to install SOL-98."
            : "Use your browser menu → “Install app” (or “Add to Home Screen”)."}
        </div>
      )}
    </span>
  );
}
