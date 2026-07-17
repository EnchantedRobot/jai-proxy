  // ---------------------------------------------------------------------------
  // bootstrap
  // ---------------------------------------------------------------------------
  function boot() {
    Overlay.mount();
    Overlay.keepAlive();
    scheduleTick(0);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleTick(0);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
