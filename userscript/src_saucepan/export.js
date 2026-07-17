  // ---------------------------------------------------------------------------
  // Export — fetch the companion's raw JSON export and hand it to the server
  // (POST /build-saucepan), which does the deobfuscation / mapping / PNG build.
  // The server derives the real character name from the companion JSON
  // (companion.name), so there's no name prompt. Progress lands in the status
  // line above the button (ExportStatus), mirroring the JanitorAI bridge.
  // ---------------------------------------------------------------------------
  async function exportCompanion() {
    const btn = ExportButton._el;
    btn.disabled = true;
    ExportStatus.show("Fetching…");
    let holdMs = 2500;
    try {
      const id = SaucepanClient.companionIdFromUrl();
      if (!id) {
        ExportStatus.show("⚠️ Open a /companion/<id> page first", true);
        holdMs = 5000;
        return;
      }

      const export_ = await SaucepanClient.fetchExport(id, (p) => {
        if (p.phase === "lore") {
          ExportStatus.show(`Fetching lore ${p.done} / ${p.total}…`);
        } else if (p.phase === "companion") {
          ExportStatus.show("Fetching companion…");
        } else {
          ExportStatus.show("Fetching…");
        }
      });

      ExportStatus.show("Building on server…");
      const res = await ServerClient.build({ character: export_ });
      const warnings = res.warnings || [];
      if (res.ok) {
        log("built:", res.path, "warnings:", warnings);
        if (warnings.length) {
          const n = warnings.length;
          ExportStatus.show(`⚠️ Saved — ${n} warning${n === 1 ? "" : "s"}`, false);
          holdMs = 8000;
        } else {
          ExportStatus.show("✓ Saved");
        }
      } else {
        ExportStatus.show(`⚠️ ${warnings[0] || "build failed"}`, true);
        holdMs = 8000;
        warn("build failed:", warnings);
      }
    } catch (err) {
      ExportStatus.show("⚠️ " + (err && err.message ? err.message : String(err)), true);
      holdMs = 8000;
      warn(err);
    } finally {
      setTimeout(() => {
        ExportStatus.hide();
        btn.disabled = false;
      }, holdMs);
    }
  }
