/* global Zotero, Services, Cc, Ci, ChromeUtils, IOUtils, PathUtils, APP_SHUTDOWN */
var chromeHandle;
var scope;

async function startup({ id, version, rootURI }) {
  try {
    await Zotero.initializationPromise;
    const service = Cc["@mozilla.org/addons/addon-manager-startup;1"].getService(Ci.amIAddonManagerStartup);
    chromeHandle = service.registerChrome(Services.io.newURI(rootURI + "manifest.json"), [
      ["content", "codex-pdf-translate", "content/"],
    ]);
    const { setInterval, clearInterval } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    scope = { Zotero, Services, Cc, Ci, ChromeUtils, IOUtils, PathUtils, setInterval, clearInterval, rootURI, pluginID: id, version };
    Services.scriptloader.loadSubScript(rootURI + "content/identity.js", scope, "UTF-8");
    Services.scriptloader.loadSubScript(rootURI + "content/connection-client.js", scope, "UTF-8");
    Services.scriptloader.loadSubScript(rootURI + "content/progress.js", scope, "UTF-8");
    Services.scriptloader.loadSubScript(rootURI + "content/metadata.js", scope, "UTF-8");
    Services.scriptloader.loadSubScript(rootURI + "content/translate.js", scope, "UTF-8");
    Zotero.CodexPDFTranslate = scope.CodexPDFTranslate;
    await Zotero.CodexPDFTranslate.startup();
  } catch (error) {
    Zotero.logError(error);
    const report = Zotero.Prefs.get("extensions.zotero.codexPDFTranslate.testReport", true) ||
      Zotero.Prefs.get("extensions.zotero.codexPDFTranslate.installReport", true);
    if (report) await IOUtils.writeUTF8(report, JSON.stringify({ ok: false, error: String(error), stack: error.stack }));
  }
}

function onMainWindowLoad({ window }) {
  if (scope) scope.CodexPDFTranslate.onWindow(window);
}

function onMainWindowUnload({ window }) {
  if (scope) scope.CodexPDFTranslate.removeWindow(window);
}

async function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) return;
  if (scope) await scope.CodexPDFTranslate.shutdown();
  delete Zotero.CodexPDFTranslate;
  if (chromeHandle) chromeHandle.destruct();
  scope = null;
}

function install() {}
function uninstall() {}
